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
// B) DASHBOARD LISTA (HOME & MEASUREMENTS)
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
        COUNT(t.id) as total_trolleys, -- Ukupan broj kolica ikada napravljenih za ovu seriju
        COUNT(CASE WHEN t.is_packed = FALSE THEN 1 END) as active_trolleys, -- Broj kolica koja su još u pogonu
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

// NOVO: RUTA ZA ARHIVIRANE SERIJE (MONITORING)
app.get('/api/batches/archived', async (req, res) => {
    try {
        const query = `
        SELECT 
            b.id, 
            b.batch_code, 
            b.lot_number, 
            p.name as product_name
        FROM batches b
        JOIN products p ON b.product_id = p.id
        WHERE b.is_active = FALSE
        ORDER BY b.production_date DESC
        LIMIT 100; -- Limitiramo na poslednjih 100 da ne preopteretimo listu
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// --------------------------
// C) ANALITIKA (DASHBOARD.HTML)
// --------------------------
app.get('/api/analytics', async (req, res) => {
    try {
        const client = await pool.connect();

        // 1. KPI: Ukupno Tura i Kolica
        const kpiRes = await client.query(`
      SELECT 
        COUNT(DISTINCT b.id) as total_batches,
        COUNT(t.id) as total_trolleys
      FROM batches b
      LEFT JOIN trolleys t ON b.id = t.batch_id
      WHERE b.is_active = TRUE
    `);

        // 2. KPI: Ukupna Masa (Trenutna u pogonu)
        const weightRes = await client.query(`
        SELECT SUM(m.gross_weight) as total_weight
        FROM measurements m
        INNER JOIN (
            SELECT trolley_id, MAX(measured_at) as max_date 
            FROM measurements GROUP BY trolley_id
        ) latest ON m.trolley_id = latest.trolley_id AND m.measured_at = latest.max_date
        JOIN trolleys t ON m.trolley_id = t.id
        JOIN batches b ON t.batch_id = b.id
        WHERE b.is_active = TRUE
    `);

        // 3. GRAFIK 1: Kolica po proizvodima
        const trolleysPerProductRes = await client.query(`
        SELECT p.name, COUNT(t.id) as count
        FROM trolleys t
        JOIN batches b ON t.batch_id = b.id
        JOIN products p ON b.product_id = p.id
        WHERE b.is_active = TRUE
        GROUP BY p.name ORDER BY count DESC
    `);

        // 4. GRAFIK 2: Struktura proizvodnje
        const batchesPerProductRes = await client.query(`
        SELECT p.name, COUNT(b.id) as count
        FROM batches b
        JOIN products p ON b.product_id = p.id
        WHERE b.is_active = TRUE
        GROUP BY p.name
    `);

        // 5. LISTA AKTIVNIH SERIJA (ZA RASPORED PAKOVANJA)
        const activeListRes = await client.query(`
        SELECT 
            b.id, b.batch_code, b.production_date, b.lot_number,
            p.name as product_name, 
            p.target_duration_days,
            p.standard_loss_percentage,
            (CURRENT_DATE - b.production_date) as days_old,
            (p.target_duration_days - (CURRENT_DATE - b.production_date)) as days_remaining,
            COUNT(t.id) as trolley_count,
            SUM(COALESCE(start_m.gross_weight, 0) - t.tare_weight - (t.stick_count * 0.4)) as total_net_1
        FROM batches b
        JOIN products p ON b.product_id = p.id
        LEFT JOIN trolleys t ON b.id = t.batch_id
        LEFT JOIN measurements start_m ON start_m.trolley_id = t.id AND start_m.phase = 'PROIZVODNJA'
        WHERE b.is_active = TRUE
        GROUP BY b.id, p.name, p.target_duration_days, p.standard_loss_percentage, b.production_date, b.lot_number
        ORDER BY days_remaining ASC
    `);

        // 6. DETALJNA STATISTIKA PO PROIZVODIMA (TAB 2)
        const productDetailsRes = await client.query(`
        SELECT 
            p.name, 
            p.standard_loss_percentage,
            COUNT(t.id) as total_trolleys,
            SUM(COALESCE(start_m.gross_weight, 0) - t.tare_weight - (t.stick_count * 0.4)) as total_net_1
        FROM batches b
        JOIN products p ON b.product_id = p.id
        JOIN trolleys t ON b.id = t.batch_id
        LEFT JOIN measurements start_m ON start_m.trolley_id = t.id AND start_m.phase = 'PROIZVODNJA'
        WHERE b.is_active = TRUE
        GROUP BY p.name, p.standard_loss_percentage
    `);

        // 7. ISTORIJA KALA (TAB 4 - ZAVRŠENE SERIJE)
        const historyRes = await client.query(`
        SELECT 
            b.batch_code,
            p.name as product_name,
            SUM(COALESCE(start_m.gross_weight, 0) - t.tare_weight - (t.stick_count * 0.4)) as total_net_1,
            SUM(COALESCE(end_m.gross_weight, 0) - t.tare_weight - (t.stick_count * 0.4)) as total_net_2
        FROM batches b
        JOIN products p ON b.product_id = p.id
        JOIN trolleys t ON b.id = t.batch_id
        LEFT JOIN measurements start_m ON start_m.trolley_id = t.id AND start_m.phase = 'PROIZVODNJA'
        LEFT JOIN measurements end_m ON end_m.trolley_id = t.id AND end_m.phase = 'PAKOVANJE'
        WHERE b.is_active = FALSE
        GROUP BY b.batch_code, p.name
        HAVING SUM(COALESCE(end_m.gross_weight, 0)) > 0
        ORDER BY b.batch_code DESC
    `);

        client.release();

        res.json({
            kpi: {
                totalBatches: parseInt(kpiRes.rows[0].total_batches || 0),
                totalTrolleys: parseInt(kpiRes.rows[0].total_trolleys || 0),
                totalWeight: parseFloat(weightRes.rows[0].total_weight || 0).toFixed(1)
            },
            activeList: activeListRes.rows,
            productStats: productDetailsRes.rows,
            historyStats: historyRes.rows, // <--- NOVO
            charts: {
                trolleysByProduct: trolleysPerProductRes.rows,
                structure: batchesPerProductRes.rows
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// --------------------------
// D) UPRAVLJANJE SERIJAMA
// --------------------------

app.post('/api/batches', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { productCode, batchCode, lotNumber, trolleysCount, chamber, productionDate } = req.body;

        const prodRes = await client.query(
            'SELECT id, default_trolley_weight, default_stick_count, default_piece_count FROM products WHERE code = $1',
            [productCode]
        );
        if (prodRes.rows.length === 0) throw new Error('Nepoznat proizvod');
        const product = prodRes.rows[0];

        const batchRes = await client.query(
            `INSERT INTO batches (product_id, batch_code, lot_number, current_chamber, production_date) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [product.id, batchCode, lotNumber, chamber, productionDate]
        );
        const batchId = batchRes.rows[0].id;

        for (let i = 1; i <= trolleysCount; i++) {
            await client.query(
                'INSERT INTO trolleys (batch_id, trolley_number, tare_weight, stick_count) VALUES ($1, $2, $3, $4)',
                [batchId, i, product.default_trolley_weight, product.default_stick_count]
            );
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
        (SELECT gross_weight FROM measurements m WHERE m.trolley_id = t.id AND m.phase = 'PROIZVODNJA' LIMIT 1) as start_gross,
        (SELECT gross_weight FROM measurements m WHERE m.trolley_id = t.id ORDER BY m.measured_at DESC LIMIT 1) as current_gross,
        (SELECT piece_count FROM measurements m WHERE m.trolley_id = t.id ORDER BY m.measured_at DESC LIMIT 1) as current_pieces,
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
// E) MERENJA (CORE LOGIC)
// --------------------------

app.post('/api/measurements', async (req, res) => {
    const { trolleyId, weight, ph, phase, pieces, stickCount, tare, weightProduction, date } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const measureDate = date ? date : 'NOW()';

        if (stickCount !== undefined || tare !== undefined) {
            await client.query('UPDATE trolleys SET stick_count = COALESCE($1, stick_count), tare_weight = COALESCE($2, tare_weight) WHERE id = $3', [stickCount, tare, trolleyId]);
        }

        if (weightProduction !== undefined && weightProduction !== null) {
            const check = await client.query("SELECT id FROM measurements WHERE trolley_id = $1 AND phase = 'PROIZVODNJA'", [trolleyId]);
            if (check.rows.length > 0) {
                await client.query("UPDATE measurements SET gross_weight = $1, piece_count = COALESCE($2, piece_count) WHERE id = $3", [weightProduction, pieces, check.rows[0].id]);
            } else {
                await client.query("INSERT INTO measurements (trolley_id, gross_weight, piece_count, phase, measured_at) VALUES ($1, $2, $3, 'PROIZVODNJA', $4)", [trolleyId, weightProduction, pieces, measureDate]);
            }
        } else if (pieces && !weight && !ph && !weightProduction) {
            const check = await client.query("SELECT id FROM measurements WHERE trolley_id = $1 AND phase = 'PROIZVODNJA'", [trolleyId]);
            if (check.rows.length > 0) {
                await client.query("UPDATE measurements SET piece_count = $1 WHERE id = $2", [pieces, check.rows[0].id]);
            }
        }

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
// F) KOLICA (TROLLEYS)
// --------------------------

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
// G) PROIZVODI (PRODUCTS)
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
// H) PAKOVANJE
// --------------------------

app.get('/api/packaging/active', async (req, res) => {
    try {
        const query = `
      SELECT DISTINCT b.id, b.batch_code, b.lot_number, b.product_id, p.name as product_name
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

app.post('/api/packaging/lookup', async (req, res) => {
    const { lot, trolleyNum } = req.body;
    try {
        const query = `
      SELECT 
        t.id as trolley_id, t.trolley_number, t.tare_weight, t.stick_count, 
        b.id as batch_id, b.batch_code, b.product_id,
        (SELECT gross_weight FROM measurements m WHERE m.trolley_id = t.id AND m.phase = 'PROIZVODNJA' LIMIT 1) as start_gross
      FROM trolleys t
      JOIN batches b ON t.batch_id = b.id
      WHERE b.lot_number = $1 AND t.trolley_number = $2 AND t.is_packed = FALSE AND b.is_active = TRUE;
    `;
        const result = await pool.query(query, [lot, trolleyNum]);
        if (result.rows.length > 0) res.json({ success: true, data: result.rows[0] });
        else res.json({ success: false, message: 'Kolica nisu pronađena ili su već spakovana.' });
    } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

app.post('/api/packaging/pack', async (req, res) => {
    const { trolleyId, weight, ph, date, batchId } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        await client.query(
            `INSERT INTO measurements (trolley_id, gross_weight, ph_value, phase, measured_at)
       VALUES ($1, $2, $3, 'PAKOVANJE', $4)`,
            [trolleyId, weight, ph, date || 'NOW()']
        );

        await client.query('UPDATE trolleys SET is_packed = TRUE WHERE id = $1', [trolleyId]);

        const checkRes = await client.query('SELECT COUNT(*) as remaining FROM trolleys WHERE batch_id = $1 AND is_packed = FALSE', [batchId]);
        let batchStatus = 'active';
        if (parseInt(checkRes.rows[0].remaining) === 0) {
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
// I) KORISNICI
// --------------------------

app.get('/api/users', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, username, role, first_name, last_name FROM users ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.post('/api/users', async (req, res) => {
    const { username, password, role, first_name, last_name } = req.body;
    try {
        await pool.query(
            'INSERT INTO users (username, password, role, first_name, last_name) VALUES ($1, $2, $3, $4, $5)',
            [username, password, role, first_name, last_name]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        if (err.code === '23505') res.status(400).json({ success: false, message: 'Korisničko ime već postoji!' });
        else res.status(500).json({ success: false, message: 'Greška na serveru.' });
    }
});

app.put('/api/users/:id', async (req, res) => {
    const { id } = req.params;
    const { username, password, role, first_name, last_name } = req.body;

    try {
        if (password && password.trim() !== '') {
            await pool.query(
                'UPDATE users SET username=$1, password=$2, role=$3, first_name=$4, last_name=$5 WHERE id=$6',
                [username, password, role, first_name, last_name, id]
            );
        } else {
            await pool.query(
                'UPDATE users SET username=$1, role=$2, first_name=$3, last_name=$4 WHERE id=$5',
                [username, role, first_name, last_name, id]
            );
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        if (err.code === '23505') res.status(400).json({ success: false, message: 'Korisničko ime već postoji!' });
        else res.status(500).json({ success: false, message: 'Greška na serveru.' });
    }
});

app.delete('/api/users/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM users WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// --------------------------
// 4. POKRETANJE
// --------------------------
app.listen(port, () => {
    console.log(`Server radi na http://localhost:${port}`);
});