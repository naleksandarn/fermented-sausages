document.addEventListener('DOMContentLoaded', () => {
    // ============================================================
    // 1. KONFIGURACIJA I AUTENTIFIKACIJA
    // ============================================================

    const user = JSON.parse(localStorage.getItem('currentUser'));
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    const isCEO = (user.role === 'ceo');
    const isAdmin = (user.role === 'admin');
    const API_URL = '/api'; // Relativna putanja za produkciju

    // --- STATE PROMENLJIVE ---
    let batches = [];
    let draggedBatchId = null;
    let currentBatchIdForDetails = null;

    // --- WIZARD STATE (SERIJA) ---
    let currentStep = 1;
    let isWizardMode = true;
    const totalSteps = 3;

    // --- WIZARD STATE (KOLICA) ---
    let trCurrentStep = 1;

    // ============================================================
    // 2. UI I NAVIGACIJA
    // ============================================================

    // Dodavanje dugmeta "Početna" u header
    const header = document.querySelector('.app-header');
    if (header) {
        // Provera da ne dupliramo dugme
        if (!header.querySelector('.btn-back-menu')) {
            const backBtn = document.createElement('button');
            backBtn.className = 'btn-secondary btn-back-menu';
            backBtn.innerHTML = '🏠 Početna'; // IZMENJENO
            backBtn.style.marginRight = '10px';
            backBtn.onclick = () => window.location.href = 'home.html';
            header.insertBefore(backBtn, header.firstChild);
        }
    }

    // Elementi glavnog ekrana
    const addBatchBtn = document.getElementById('addBatchBtn');
    const currentDateEl = document.getElementById('currentDate');
    if (currentDateEl) currentDateEl.textContent = new Date().toLocaleDateString('sr-RS');

    // Sakrivanje dugmeta za CEO
    if (addBatchBtn && isCEO) {
        addBatchBtn.style.display = 'none';
    }

    // DOM Elementi Modala (Serija)
    const modal = document.getElementById('batchModal');
    const batchForm = document.getElementById('batchForm');
    const wizardSteps = document.querySelectorAll('.wizard-step:not([data-tr-step])');
    const stepIndicators = document.querySelectorAll('#wizardProgress .step-indicator');
    const progressFill = document.getElementById('progressFill');
    const nextBtn = document.getElementById('nextBtn');
    const prevBtn = document.getElementById('prevBtn');
    const submitBtn = document.getElementById('submitBtn');
    const wizardProgress = document.getElementById('wizardProgress');
    const toggleWizardBtn = document.getElementById('toggleWizardBtn');
    const cancelBtn = document.getElementById('cancelBtn');

    // DOM Elementi Modala (Detalji)
    const detailsModal = document.getElementById('detailsModal');
    const closeDetailsBtn = document.getElementById('closeDetailsBtn');
    const closeDetailsBtnBottom = document.getElementById('closeDetailsBtnBottom');

    // DOM Elementi Modala (Kolica)
    const trolleyModal = document.getElementById('trolleyModal');
    const trNextBtn = document.getElementById('trNextBtn');
    const trPrevBtn = document.getElementById('trPrevBtn');
    const trSubmitBtn = document.getElementById('trSubmitBtn');
    const trCancelBtn = document.getElementById('trCancelBtn');
    const addTrolleyBtn = document.getElementById('addTrolleyBtn');

    // ============================================================
    // 3. INICIJALIZACIJA
    // ============================================================

    populateProductSelect();
    loadData();

    // Logika za auto-otvaranje (iz production.html)
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('action') === 'create' && !isCEO) {
        setTimeout(() => {
            if (modal) openCreateModal();
        }, 200);
    }

    // ============================================================
    // 4. WIZARD LOGIKA: KREIRANJE SERIJE
    // ============================================================

    // Otvaranje
    if (addBatchBtn && !isCEO) {
        addBatchBtn.addEventListener('click', () => openCreateModal());
    }

    function openCreateModal() {
        modal.classList.remove('hidden');
        if (batchForm) {
            batchForm.reset();
            // Datum na danas
            const dInput = document.getElementById('productionDate');
            if (dInput) dInput.valueAsDate = new Date();

            // Reset Wizard UI
            currentStep = 1;
            isWizardMode = true;
            if (toggleWizardBtn) toggleWizardBtn.textContent = "Prebaci na klasičan prikaz";
            if (wizardProgress) wizardProgress.style.display = 'flex';
            if (prevBtn) prevBtn.style.display = 'block';
            if (cancelBtn) cancelBtn.style.display = 'none';

            updateWizardUI();
            setTimeout(generateBatchCode, 100);
        }
    }


    // Listeneri za auto-generisanje koda
    const prodSelect = document.getElementById('productType');
    const dateInput = document.getElementById('productionDate');
    if (prodSelect) prodSelect.addEventListener('change', generateBatchCode);
    if (dateInput) dateInput.addEventListener('change', generateBatchCode);

    function generateBatchCode() {
        const prodCode = document.getElementById('productType').value;
        const dateVal = document.getElementById('productionDate').value;
        const batchInput = document.getElementById('batchCode');

        if (prodCode && dateVal && batchInput) {
            const cleanDate = dateVal.replaceAll('-', '');
            batchInput.value = prodCode + cleanDate;
        }
    }

    // Navigacija Wizarda
    if (batchForm) {
        if (nextBtn) nextBtn.addEventListener('click', () => { if (validateStep(currentStep)) { currentStep++; updateWizardUI(); } });
        if (prevBtn) prevBtn.addEventListener('click', () => { if (currentStep > 1) { currentStep--; updateWizardUI(); } });
    }

    // Toggle Mode
    if (toggleWizardBtn) {
        toggleWizardBtn.addEventListener('click', () => {
            isWizardMode = !isWizardMode;
            if (isWizardMode) {
                toggleWizardBtn.textContent = "Prebaci na klasičan prikaz";
                wizardProgress.style.display = 'flex';
                prevBtn.style.display = 'block';
                cancelBtn.style.display = 'none';
                updateWizardUI();
            } else {
                toggleWizardBtn.textContent = "Prebaci na Čarobnjak (Wizard)";
                wizardProgress.style.display = 'none';
                wizardSteps.forEach(step => step.classList.add('active'));
                prevBtn.style.display = 'none';
                nextBtn.style.display = 'none';
                submitBtn.style.display = 'block';
                cancelBtn.style.display = 'block';
            }
        });
    }

    // Zatvaranje i Submit
    if (cancelBtn) cancelBtn.addEventListener('click', () => modal.classList.add('hidden'));
    if (batchForm) batchForm.addEventListener('submit', handleFormSubmit);

    function updateWizardUI() {
        if (!isWizardMode) return;

        wizardSteps.forEach((step, index) => {
            step.classList.toggle('active', index + 1 === currentStep);
        });

        stepIndicators.forEach((ind, index) => {
            ind.className = 'step-indicator';
            if (index + 1 < currentStep) {
                ind.classList.add('completed');
                ind.innerHTML = '✓';
            } else if (index + 1 === currentStep) {
                ind.classList.add('active');
                ind.innerHTML = index + 1;
            } else {
                ind.innerHTML = index + 1;
            }
        });

        const progress = ((currentStep - 1) / (totalSteps - 1)) * 100;
        if (progressFill) progressFill.style.width = `${progress}%`;

        if (prevBtn) prevBtn.disabled = (currentStep === 1);

        if (currentStep === totalSteps) {
            if (nextBtn) nextBtn.style.display = 'none';
            if (submitBtn) submitBtn.style.display = 'block';

            // Summary
            const prodName = document.getElementById('productType').options[document.getElementById('productType').selectedIndex]?.text;
            const code = document.getElementById('batchCode').value;
            const count = document.getElementById('trolleyCount').value;
            const sumEl = document.getElementById('summaryText');
            if (sumEl) sumEl.innerHTML = `Proizvod: <strong>${prodName}</strong><br>Serija: ${code}<br>Ramova: ${count}`;
        } else {
            if (nextBtn) nextBtn.style.display = 'block';
            if (submitBtn) submitBtn.style.display = 'none';
        }
    }

    function validateStep(step) {
        const stepDiv = document.querySelector(`.wizard-step[data-step="${step}"]`);
        const inputs = stepDiv.querySelectorAll('input, select');
        let valid = true;
        inputs.forEach(input => {
            if (input.hasAttribute('required') && !input.value) {
                valid = false;
                input.style.borderColor = 'red';
                input.addEventListener('input', () => input.style.borderColor = '#cbd5e1');
            }
        });
        if (!valid) alert("Popunite obavezna polja.");
        return valid;
    }

    // ============================================================
    // 5. WIZARD LOGIKA: DODAVANJE KOLICA (3 KORAKA)
    // ============================================================

    if (addTrolleyBtn) {
        const newAddBtn = addTrolleyBtn.cloneNode(true);
        addTrolleyBtn.parentNode.replaceChild(newAddBtn, addTrolleyBtn);

        newAddBtn.addEventListener('click', () => {
            if (!currentBatchIdForDetails) return;

            trolleyModal.classList.remove('hidden');
            document.getElementById('trolleyForm').reset();
            trCurrentStep = 1;
            updateTrolleyUI();

            // Smart default (poslednji uneti podaci iz tabele)
            const lastTareRow = document.querySelector('#trolleysTableBody tr:last-child input[id^="tare-"]');
            const lastStickRow = document.querySelector('#trolleysTableBody tr:last-child input[id^="sticks-"]');
            const lastPiecesRow = document.querySelector('#trolleysTableBody tr:last-child input[id^="pieces-"]');

            if (lastTareRow) document.getElementById('newTrolleyTare').value = lastTareRow.value;
            if (lastStickRow) document.getElementById('newTrolleySticks').value = lastStickRow.value;
            if (lastPiecesRow) document.getElementById('newTrolleyPieces').value = lastPiecesRow.value;
        });
    }

    if (trCancelBtn) trCancelBtn.addEventListener('click', () => trolleyModal.classList.add('hidden'));

    // Navigacija Trolley Wizarda
    if (trNextBtn) {
        trNextBtn.addEventListener('click', () => {
            if (trCurrentStep === 1) {
                const tare = document.getElementById('newTrolleyTare').value;
                const sticks = document.getElementById('newTrolleySticks').value;
                if (!tare || !sticks) { alert("Popunite Taru i Broj štapova."); return; }

                // Update summary
                document.getElementById('summaryTare').textContent = tare;
                document.getElementById('summarySticks').textContent = sticks;

                trCurrentStep = 2;
                updateTrolleyUI();
                setTimeout(() => document.getElementById('newTrolleyGross').focus(), 100);

            } else if (trCurrentStep === 2) {
                const gross = document.getElementById('newTrolleyGross').value;
                document.getElementById('summaryGross').textContent = gross || "-";

                trCurrentStep = 3;
                updateTrolleyUI();
                setTimeout(() => document.getElementById('newTrolleyPieces').focus(), 100);
            }
        });
    }

    if (trPrevBtn) {
        trPrevBtn.addEventListener('click', () => {
            if (trCurrentStep > 1) {
                trCurrentStep--;
                updateTrolleyUI();
            }
        });
    }

    function updateTrolleyUI() {
        document.querySelectorAll('.wizard-step[data-tr-step]').forEach(step => {
            step.classList.toggle('active', step.dataset.trStep == trCurrentStep);
        });

        const ind1 = document.getElementById('trStep1');
        const ind2 = document.getElementById('trStep2');
        const ind3 = document.getElementById('trStep3');
        const fill = document.getElementById('trolleyProgressFill');

        [ind1, ind2, ind3].forEach(ind => ind.className = 'step-indicator');

        if (trCurrentStep === 1) {
            ind1.classList.add('active'); ind1.innerHTML = '1';
            ind2.innerHTML = '2'; ind3.innerHTML = '3';
            fill.style.width = '0%';
            trPrevBtn.disabled = true;
            trNextBtn.style.display = 'block';
            trSubmitBtn.style.display = 'none';
        } else if (trCurrentStep === 2) {
            ind1.classList.add('completed'); ind1.innerHTML = '✓';
            ind2.classList.add('active'); ind2.innerHTML = '2';
            ind3.innerHTML = '3';
            fill.style.width = '50%';
            trPrevBtn.disabled = false;
            trNextBtn.style.display = 'block';
            trSubmitBtn.style.display = 'none';
        } else {
            // Korak 3
            ind1.classList.add('completed'); ind1.innerHTML = '✓';
            ind2.classList.add('completed'); ind2.innerHTML = '✓';
            ind3.classList.add('active'); ind3.innerHTML = '3';
            fill.style.width = '100%';
            trPrevBtn.disabled = false;
            trNextBtn.style.display = 'none';
            trSubmitBtn.style.display = 'block';
        }
    }

    // Submit novih kolica
    const trolleyForm = document.getElementById('trolleyForm');
    if (trolleyForm) {
        trolleyForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const tare = parseFloat(document.getElementById('newTrolleyTare').value);
            const sticks = parseInt(document.getElementById('newTrolleySticks').value);
            const gross = parseFloat(document.getElementById('newTrolleyGross').value);
            const pieces = parseInt(document.getElementById('newTrolleyPieces').value);

            try {
                // 1. Kreiraj ram
                const res = await fetch(`${API_URL}/batches/${currentBatchIdForDetails}/trolleys`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tare, sticks })
                });
                const data = await res.json();

                if (data.success) {
                    // 2. Ako ima mase ili komada, upiši merenje
                    if (gross || pieces) {
                        await fetch(`${API_URL}/measurements`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                trolleyId: data.id,
                                weightProduction: gross || null, // Bruto 1
                                weight: null, ph: null,
                                pieces: pieces || 0, // Komadi
                                phase: 'FERMENTACIJA'
                            })
                        });
                    }
                    trolleyModal.classList.add('hidden');
                    loadTrolleyDetails(currentBatchIdForDetails);
                    alert(`Dodata Kolica #${data.newNumber}`);
                } else {
                    alert("Greška pri kreiranju.");
                }
            } catch (err) { console.error(err); alert("Server greška."); }
        });
    }

    // ============================================================
    // 6. DRAG & DROP
    // ============================================================

    document.querySelectorAll('.chamber').forEach(chamber => {
        chamber.addEventListener('dragover', e => {
            e.preventDefault();
            if (!isCEO) chamber.classList.add('drag-over');
        });
        chamber.addEventListener('dragleave', () => chamber.classList.remove('drag-over'));
        chamber.addEventListener('drop', async e => {
            e.preventDefault();
            chamber.classList.remove('drag-over');
            if (isCEO) { alert("Nemate ovlašćenje."); return; }
            if (draggedBatchId) await moveBatch(draggedBatchId, chamber.dataset.id);
        });
    });

    // ============================================================
    // 7. API & UI FUNKCIJE
    // ============================================================

    async function populateProductSelect() {
        const select = document.getElementById('productType');
        if (!select) return;

        try {
            const res = await fetch(`${API_URL}/products`);
            const products = await res.json();
            select.innerHTML = '';

            if (products.length === 0) {
                select.innerHTML = '<option disabled>Nema proizvoda</option>';
                return;
            }

            products.forEach(p => {
                const option = document.createElement('option');
                option.value = p.code;
                option.textContent = p.name;
                select.appendChild(option);
            });
        } catch (err) { select.innerHTML = '<option>Greška!</option>'; }
    }

    async function loadData() {
        try {
            const res = await fetch(`${API_URL}/dashboard`);
            batches = await res.json();
            renderBatches();
        } catch (err) { console.error("Greška servera:", err); }
    }

    async function moveBatch(id, chamber) {
        const batch = batches.find(b => b.id == id);
        if (batch) batch.current_chamber = chamber;
        renderBatches();
        try {
            await fetch(`${API_URL}/batches/${id}/move`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chamber })
            });
        } catch (err) { alert("Greška pri čuvanju!"); loadData(); }
    }

    async function handleFormSubmit(e) {
        e.preventDefault();
        const payload = {
            productCode: document.getElementById('productType').value,
            batchCode: document.getElementById('batchCode').value,
            lotNumber: document.getElementById('lotNumber').value,
            productionDate: document.getElementById('productionDate').value,
            trolleysCount: parseInt(document.getElementById('trolleyCount').value),
            chamber: document.getElementById('chamberSelect').value
        };

        try {
            const res = await fetch(`${API_URL}/batches`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                modal.classList.add('hidden');
                loadData();
                alert("Uspešno kreirana serija!");
            } else {
                const data = await res.json();
                alert(data.error || "Greška!");
            }
        } catch (err) { alert("Server greška!"); }
    }

    // ============================================================
    // 8. RENDEROVANJE UI
    // ============================================================

    function renderBatches() {
        document.querySelectorAll('.chamber-content').forEach(el => el.innerHTML = '');
        batches.forEach(batch => {
            const parent = document.querySelector(`.chamber[data-id="${batch.current_chamber}"] .chamber-content`);
            if (parent) parent.appendChild(createCard(batch));
        });
        updateDashboard();
    }

    function createCard(batch) {
        const div = document.createElement('div');
        div.className = 'batch';

        if (isCEO) {
            div.style.cursor = 'default';
            div.draggable = false;
        } else {
            div.draggable = true;
            div.addEventListener('dragstart', () => draggedBatchId = batch.id);
        }

        const daysLeft = batch.days_remaining;
        let statusColor = '#2563eb';
        let statusText = 'U procesu';
        if (daysLeft <= 0) { statusColor = '#16a34a'; statusText = 'SPREMNO'; }
        else if (daysLeft < 5) { statusColor = '#d97706'; statusText = 'Uskoro'; }

        div.innerHTML = `
            <div class="batch-code">${batch.batch_code}</div>
            <div class="batch-info-row">
                <span>${batch.product_name}</span>
                <strong>${batch.trolley_count} ram.</strong>
            </div>
            <div style="margin-top:4px; font-size:0.75rem; color:${statusColor}; font-weight:600;">
                Dan ${batch.days_old} / ${batch.target_duration_days} (${statusText})
            </div>
        `;
        div.addEventListener('click', () => openDetailsModal(batch));
        return div;
    }

    function updateDashboard() {
        const stats = {};
        let total = 0;
        batches.forEach(b => {
            stats[b.product_name] = (stats[b.product_name] || 0) + parseInt(b.trolley_count);
            total += parseInt(b.trolley_count);
        });
        const board = document.getElementById('statsContent');
        if (board) {
            board.innerHTML = '';
            for (const [name, count] of Object.entries(stats)) {
                board.innerHTML += `<div class="stat-card"><div class="stat-label">${name}</div><div class="stat-value">${count}</div></div>`;
            }
        }
        const summary = document.getElementById('totalSummary');
        if (summary) summary.textContent = `Ukupno u pogonu: ${total} ramova`;
    }

    // ============================================================
    // 9. DETALJI SERIJE (TABLE LOGIC)
    // ============================================================

    if (closeDetailsBtn) closeDetailsBtn.addEventListener('click', () => detailsModal.classList.add('hidden'));
    if (closeDetailsBtnBottom) closeDetailsBtnBottom.addEventListener('click', () => detailsModal.classList.add('hidden'));

    async function openDetailsModal(batch) {
        currentBatchIdForDetails = batch.id;
        const titleEl = document.getElementById('detailsTitle');
        if (titleEl) titleEl.textContent = `Detalji: ${batch.batch_code} (${batch.product_name})`;

        const addTrlBtn = document.getElementById('addTrolleyBtn');
        if (addTrlBtn) addTrlBtn.style.display = isCEO ? 'none' : 'block';

        const deleteBtn = document.getElementById('deleteBatchBtn');
        if (deleteBtn) {
            const newDeleteBtn = deleteBtn.cloneNode(true);
            deleteBtn.parentNode.replaceChild(newDeleteBtn, deleteBtn);
            if (isAdmin) {
                newDeleteBtn.style.display = 'inline-block';
                newDeleteBtn.onclick = async () => {
                    if (confirm(`Trajno obrisati ${batch.batch_code}?`)) {
                        try {
                            await fetch(`${API_URL}/batches/${batch.id}`, { method: 'DELETE' });
                            detailsModal.classList.add('hidden');
                            loadData();
                            alert("Obrisano!");
                        } catch (err) { alert("Greška!"); }
                    }
                };
            } else { newDeleteBtn.style.display = 'none'; }
        }

        detailsModal.classList.remove('hidden');
        await loadTrolleyDetails(batch.id);
    }

    async function loadTrolleyDetails(batchId) {
        const tbody = document.getElementById('trolleysTableBody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:20px;">Učitavanje...</td></tr>';

        try {
            const res = await fetch(`${API_URL}/batches/${batchId}/details`);
            const trolleys = await res.json();
            tbody.innerHTML = '';

            trolleys.forEach(t => {
                const tare = parseFloat(t.tare_weight) || 0;
                const stickCount = parseInt(t.stick_count) || 0;
                const stickWeight = stickCount * 0.4;

                const gross1 = parseFloat(t.start_gross) || 0;
                const net1 = (gross1 > 0) ? (gross1 - tare - stickWeight) : 0;

                const pieces = t.current_pieces || t.default_piece_count || 0;

                const disabledAttr = isCEO ? 'disabled' : '';

                const inputGross1 = `<input type="number" step="0.1" class="input-small" id="gross1-${t.id}" value="${gross1 || ''}" placeholder="kg" ${disabledAttr}>`;
                const inputTare = `<input type="number" step="0.1" class="input-small" id="tare-${t.id}" value="${tare}" style="width:60px;" ${disabledAttr}>`;
                const inputSticks = `<input type="number" class="input-small" id="sticks-${t.id}" value="${stickCount}" style="width:50px;" ${disabledAttr}>`;
                const inputPieces = `<input type="number" class="input-small" id="pieces-${t.id}" value="${pieces}" placeholder="kom" style="width:60px;" ${disabledAttr}>`;

                let actionHtml = '';
                if (!isCEO) {
                    actionHtml = `
                        <div style="display:flex; gap:5px; justify-content:center;">
                            <button class="btn-small" onclick="saveMeasurement(${t.id})" title="Sačuvaj">💾</button>
                            <button class="btn-danger" style="padding:4px 8px;" onclick="deleteTrolley(${t.id}, ${t.trolley_number})" title="Obriši">X</button>
                        </div>`;
                } else { actionHtml = '<span style="color:#999; font-size:0.8rem;">Pregled</span>'; }

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td style="text-align:center;"><strong>${t.trolley_number}</strong></td>
                    <td>${inputGross1}</td>
                    <td>${inputTare}</td>
                    <td>${inputSticks}</td>
                    <td style="font-weight:bold; color:#475569;">${net1 > 0 ? net1.toFixed(2) : '-'}</td>
                    <td>${inputPieces}</td>
                    <td>${actionHtml}</td>
                `;
                tbody.appendChild(tr);
            });
        } catch (err) { console.error(err); tbody.innerHTML = '<tr><td colspan="7" style="color:red; text-align:center;">Greška.</td></tr>'; }
    }

    // ============================================================
    // 10. GLOBALNE FUNKCIJE
    // ============================================================

    window.saveMeasurement = async function (trolleyId) {
        const gross1Val = document.getElementById(`gross1-${trolleyId}`).value;
        const tareVal = document.getElementById(`tare-${trolleyId}`).value;
        const sticksVal = document.getElementById(`sticks-${trolleyId}`).value;
        const piecesVal = document.getElementById(`pieces-${trolleyId}`).value;

        if (!gross1Val && !piecesVal && !tareVal) {
            alert("Nema podataka za čuvanje.");
            return;
        }

        try {
            const payload = {
                trolleyId: trolleyId,
                weightProduction: gross1Val ? parseFloat(gross1Val) : null,
                weight: null,
                ph: null,
                pieces: piecesVal ? parseInt(piecesVal) : null,
                stickCount: sticksVal ? parseInt(sticksVal) : null,
                tare: tareVal ? parseFloat(tareVal) : null,
                phase: 'PROIZVODNJA'
            };

            const res = await fetch(`${API_URL}/measurements`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                loadTrolleyDetails(currentBatchIdForDetails);
            } else {
                alert("Greška pri čuvanju.");
            }
        } catch (err) { console.error(err); alert("Server greška."); }
    };

    window.deleteTrolley = async function (trolleyId, trolleyNum) {
        if (!confirm(`Obriši Kolica #${trolleyNum}?`)) return;
        try {
            const res = await fetch(`${API_URL}/trolleys/${trolleyId}`, { method: 'DELETE' });
            if (res.ok) loadTrolleyDetails(currentBatchIdForDetails);
            else alert("Greška pri brisanju.");
        } catch (err) { alert("Greška na serveru."); }
    };
});