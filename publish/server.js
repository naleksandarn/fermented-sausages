const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const port = 3000;

// ============================================================
// 1. KONFIGURACIJA BAZE
// ============================================================
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'fermentisane_db',
    password: 'admin',
    port: 5432,
});

// ============================================================
// 2. MIDDLEWARE
// ============================================================
app.use(cors());
app.use(bodyParser.json());

// Serviranje statičkih fajlova (HTML/CSS/JS)
// Ovo omogućava da otvorite http://host:3000/
app.use(express.static(__dirname));

// Root ruta vodi na login
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

// ============================================================
// 3. API RUTE
// ============================================================

// --------------------------
// A) AUTENTIFIKACIJA
// --------------------------
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query(
            'SELECT id, username, role FROM users WHERE username = $1 AND password = $2',
            [username, password]
        );

        if (result.rows.length > 0) {
            res.json({ success: true, user: result.rows[0] });
        } else {
            res.status(401).json({ success: false, message: 'Pogrešno ime ili lozinka' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Greška na serveru' });
    }
});

// --------------------------
// B) DASHBOARD & HOME
// --------------------------
app.get('/api/dashboard', async (req, res) => {
    try {
        const query = `
      SELECT 
        b.id,
        b.batch_code,
        b.lot_number,
        b.current_chamber,
        p.name as product_name,
        p.target_duration_days,
        COUNT(t.id) as trolley_count,
        (CURRENT_DATE - b.production_date) as days_old,
        (p.target_duration_days - (CURRENT_DATE - b.production_date)) as days_remaining
      FROM batches b
      JOIN products p ON b.product_id = p.id
      LEFT JOIN trolleys t ON b.id = t.batch_id
      WHERE b.is_active = TRUE
      GROUP BY b.id, b.lot_number, p.name, p.target_duration_days, b.production_date
      ORDER BY b.production_date ASC;
    `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// --------------------------
// C) UPRAVLJANJE SERIJAMA (BATCHES)
// --------------------------

// Kreiranje nove serije (Kompleksna transakcija)
app.post('/api/batches', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { productCode, batchCode, lotNumber, trolleysCount, chamber, productionDate } = req.body;

        // 1. Nađi ID proizvoda i njegove DEFAULT vrednosti
        const prodRes = await client.query(
            'SELECT id, default_trolley_weight, default_stick_count, default_piece_count FROM products WHERE code = $1',
            [productCode]
        );
        if (prodRes.rows.length === 0) throw new Error('Nepoznat proizvod');
        const product = prodRes.rows[0];

        // 2. Ubaci Seriju
        const batchRes = await client.query(
            `INSERT INTO batches (product_id, batch_code, lot_number, current_chamber, production_date) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [product.id, batchCode, lotNumber, chamber, productionDate]
        );
        const batchId = batchRes.rows[0].id;

        // 3. Ubaci Kolica (koristeći default vrednosti iz proizvoda)
        for (let i = 1; i <= trolleysCount; i++) {
            await client.query(
                'INSERT INTO trolleys (batch_id, trolley_number, tare_weight, stick_count) VALUES ($1, $2, $3, $4)',
                [batchId, i, product.default_trolley_weight, product.default_stick_count]
            );
            // Ovde NE upisujemo default piece_count u merenja odmah, 
            // to ćemo raditi kad se unese prvo merenje ili će se prikazati kao default na frontendu.
        }

        await client.query('COMMIT');
        res.json({ success: true, batchId });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Detalji serije (Karton)
app.get('/api/batches/:id/details', async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
      SELECT 
        t.id,
        t.trolley_number,
        t.tare_weight,
        t.stick_count,
        p.default_piece_count, 
        
        -- Start bruto (Proizvodnja)
        (SELECT gross_weight FROM measurements m WHERE m.trolley_id = t.id AND m.phase = 'PROIZVODNJA' LIMIT 1) as start_gross,
        -- Trenutno bruto (Poslednje merenje)
        (SELECT gross_weight FROM measurements m WHERE m.trolley_id = t.id ORDER BY m.measured_at DESC LIMIT 1) as current_gross,
        -- Trenutni komadi
        (SELECT piece_count FROM measurements m WHERE m.trolley_id = t.id ORDER BY m.measured_at DESC LIMIT 1) as current_pieces,
        -- Trenutni pH
        (SELECT ph_value FROM measurements m WHERE m.trolley_id = t.id ORDER BY m.measured_at DESC LIMIT 1) as current_ph
      FROM trolleys t
      JOIN batches b ON t.batch_id = b.id
      JOIN products p ON b.product_id = p.id
      WHERE t.batch_id = $1
      ORDER BY t.trolley_number ASC;
    `;
        const result = await pool.query(query, [id]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// Istorija merenja (Za grafik i admin pregled)
app.get('/api/batches/:id/history', async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
      SELECT 
        m.id as measurement_id,
        m.measured_at,
        m.phase,
        m.gross_weight,
        m.ph_value,
        m.piece_count,
        t.trolley_number,
        t.tare_weight,
        t.stick_count,
        (SELECT gross_weight FROM measurements start_m WHERE start_m.trolley_id = t.id AND start_m.phase = 'PROIZVODNJA' LIMIT 1) as start_gross
      FROM measurements m
      JOIN trolleys t ON m.trolley_id = t.id
      WHERE t.batch_id = $1
      ORDER BY m.measured_at DESC, t.trolley_number ASC;
    `;
        const result = await pool.query(query, [id]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// Premeštanje serije
app.put('/api/batches/:id/move', async (req, res) => {
    const { id } = req.params;
    const { chamber } = req.body;
    try {
        await pool.query('UPDATE batches SET current_chamber = $1 WHERE id = $2', [chamber, id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// Brisanje serije (Cascade briše sve povezano)
app.delete('/api/batches/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM batches WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// --------------------------
// D) MERENJA (CORE LOGIC)
// --------------------------

app.post('/api/measurements', async (req, res) => {
    const { trolleyId, weight, ph, phase, pieces, stickCount, tare, weightProduction, date } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Ako je datum poslat (iz wizarda), koristi ga, inače NOW()
        const measureDate = date ? date : 'NOW()';

        // 1. Ažuriraj Konfiguraciju Kolica (Tara i Štapovi)
        if (stickCount !== undefined || tare !== undefined) {
            await client.query(
                'UPDATE trolleys SET stick_count = COALESCE($1, stick_count), tare_weight = COALESCE($2, tare_weight) WHERE id = $3',
                [stickCount, tare, trolleyId]
            );
        }

        // 2. Ažuriraj/Kreiraj 'PROIZVODNJA' red (Bruto 1 i Komadi)
        // Ako imamo weightProduction ILI pieces (a kontekst je početni unos)
        if (weightProduction !== undefined && weightProduction !== null) {
            const check = await client.query("SELECT id FROM measurements WHERE trolley_id = $1 AND phase = 'PROIZVODNJA'", [trolleyId]);

            if (check.rows.length > 0) {
                // Update postojećeg (Ažuriramo i masu i komade)
                await client.query(
                    "UPDATE measurements SET gross_weight = $1, piece_count = COALESCE($2, piece_count) WHERE id = $3",
                    [weightProduction, pieces, check.rows[0].id]
                );
            } else {
                // Insert novog
                await client.query(
                    "INSERT INTO measurements (trolley_id, gross_weight, piece_count, phase, measured_at) VALUES ($1, $2, $3, 'PROIZVODNJA', $4)",
                    [trolleyId, weightProduction, pieces, measureDate]
                );
            }
        } else if (pieces && !weight && !ph) {
            // Specijalan slučaj: Samo menjamo broj komada u Detaljima, a nismo dirali Bruto 1
            // Pokušamo da ažuriramo Proizvodnju jer se komadi obično definišu na početku
            const check = await client.query("SELECT id FROM measurements WHERE trolley_id = $1 AND phase = 'PROIZVODNJA'", [trolleyId]);
            if (check.rows.length > 0) {
                await client.query("UPDATE measurements SET piece_count = $1 WHERE id = $2", [pieces, check.rows[0].id]);
            }
        }

        // 3. Upiši novo tekuće merenje (Fermentacija) - Bruto 2 / pH
        // Uslov: Ako su uneti težina ILI ph (a nije samo setup proizvodnje)
        if (weight || ph) {
            await client.query(
                `INSERT INTO measurements (trolley_id, gross_weight, ph_value, piece_count, phase, measured_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
                [trolleyId, weight, ph, pieces, phase, measureDate]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).send('Server error');
    } finally {
        client.release();
    }
});

// Izmena pojedinačnog reda (Admin)
app.put('/api/measurements/:id', async (req, res) => {
    const { id } = req.params;
    const { weight, ph, pieces, date } = req.body;
    try {
        await pool.query(
            'UPDATE measurements SET gross_weight = $1, ph_value = $2, piece_count = $3, measured_at = $4 WHERE id = $5',
            [weight, ph, pieces, date, id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// Brisanje pojedinačnog reda (Admin)
app.delete('/api/measurements_row/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM measurements WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// --------------------------
// E) KOLICA (TROLLEYS)
// --------------------------

// Dodaj novi ram (Wizard - sa custom podacima)
app.post('/api/batches/:id/trolleys', async (req, res) => {
    const { id } = req.params;
    const { tare, sticks } = req.body;
    try {
        const maxRes = await pool.query('SELECT COALESCE(MAX(trolley_number), 0) as max_num FROM trolleys WHERE batch_id = $1', [id]);
        const nextNum = maxRes.rows[0].max_num + 1;

        const insertRes = await pool.query(
            'INSERT INTO trolleys (batch_id, trolley_number, tare_weight, stick_count) VALUES ($1, $2, $3, $4) RETURNING id',
            [id, nextNum, tare || 40.0, sticks || 0]
        );

        res.json({ success: true, newNumber: nextNum, id: insertRes.rows[0].id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// Obriši ram
app.delete('/api/trolleys/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM trolleys WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// --------------------------
// F) PROIZVODI (PRODUCTS)
// --------------------------

app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/api/products', async (req, res) => {
    const { name, code, days, loss, defTare, defSticks, defPieces } = req.body;
    try {
        await pool.query(
            'INSERT INTO products (name, code, target_duration_days, standard_loss_percentage, default_trolley_weight, default_stick_count, default_piece_count) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [name, code, days, loss, defTare, defSticks, defPieces]
        );
        res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

app.put('/api/products/:id', async (req, res) => {
    const { id } = req.params;
    const { name, code, days, loss, defTare, defSticks, defPieces } = req.body;
    try {
        await pool.query(
            'UPDATE products SET name=$1, code=$2, target_duration_days=$3, standard_loss_percentage=$4, default_trolley_weight=$5, default_stick_count=$6, default_piece_count=$7 WHERE id=$8',
            [name, code, days, loss, defTare, defSticks, defPieces, id]
        );
        res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

app.delete('/api/products/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM products WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(400).json({ success: false, message: 'Ne mogu obrisati proizvod koji se koristi!' });
    }
});

// --------------------------
// G) PAKOVANJE (PACKAGING)
// --------------------------

// 1. Daj mi listu serija koje imaju NEspakovana kolica
app.get('/api/packaging/active', async (req, res) => {
    try {
        const query = `
      SELECT DISTINCT b.id, b.batch_code, b.product_id, p.name as product_name
      FROM batches b
      JOIN products p ON b.product_id = p.id
      JOIN trolleys t ON b.id = t.batch_id
      WHERE b.is_active = TRUE AND t.is_packed = FALSE
      ORDER BY b.batch_code ASC;
    `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// 2. Daj mi kolica za određenu seriju (Samo ona koja NISU spakovana)
app.get('/api/packaging/batches/:id/trolleys', async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
      SELECT t.id, t.trolley_number, t.tare_weight, t.stick_count
      FROM trolleys t
      WHERE t.batch_id = $1 AND t.is_packed = FALSE
      ORDER BY t.trolley_number ASC;
    `;
        const result = await pool.query(query, [id]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// 3. IZVRŠI PAKOVANJE (Action)
app.post('/api/packaging/pack', async (req, res) => {
    const { trolleyId, weight, ph, date, batchId } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // A) Upiši merenje (Faza PAKOVANJE)
        await client.query(
            `INSERT INTO measurements (trolley_id, gross_weight, ph_value, phase, measured_at)
       VALUES ($1, $2, $3, 'PAKOVANJE', $4)`,
            [trolleyId, weight, ph, date || 'NOW()']
        );

        // B) Označi kolica kao spakovana
        await client.query('UPDATE trolleys SET is_packed = TRUE WHERE id = $1', [trolleyId]);

        // C) PROVERA: Da li ima još nespakovanih kolica u ovoj seriji?
        const checkRes = await client.query(
            'SELECT COUNT(*) as remaining FROM trolleys WHERE batch_id = $1 AND is_packed = FALSE',
            [batchId]
        );

        let batchStatus = 'active';
        if (parseInt(checkRes.rows[0].remaining) === 0) {
            // Nema više kolica -> Deaktiviraj seriju (nestaje sa mape)
            await client.query('UPDATE batches SET is_active = FALSE WHERE id = $1', [batchId]);
            batchStatus = 'closed';
        }

        await client.query('COMMIT');
        res.json({ success: true, batchStatus });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).send('Server error');
    } finally {
        client.release();
    }
});

// --------------------------
// 5. POKRETANJE
// --------------------------
app.listen(port, () => {
    console.log(`Server radi na http://localhost:${port}`);
});