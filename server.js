// Al principio de server.js, configura el cliente con cookies igual que en extraer_auto.js
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');

const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

const jar = new CookieJar();
const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    baseURL: 'https://volperseal.goldensystem.com.pe'
}));

const fs = require('fs');

function getSavedCredentials() {
    const credPath = path.join(__dirname, 'data', 'credentials.json');
    if (fs.existsSync(credPath)) {
        try {
            return JSON.parse(fs.readFileSync(credPath, 'utf8'));
        } catch (e) {
            console.error("Error reading credentials.json:", e);
        }
    }
    return {
        ventasEmail: "",
        ventasPassword: "",
        almacenEmail: "",
        almacenPassword: ""
    };
}

function saveSavedCredentials(creds) {
    const credPath = path.join(__dirname, 'data', 'credentials.json');
    fs.writeFileSync(credPath, JSON.stringify(creds, null, 4));
}

// Bypasseamos el control de sesión ya que la app corre localmente sin login
function getUser(req) {
    return { email: "config@config.com" };
}

// Función para asegurar login con credenciales dinámicas en Volper
async function login(email, password) {
    const loginPage = await client.get('/login');
    const $ = cheerio.load(loginPage.data);
    const csrfToken = $('input[name="_token"]').val();
    const loginResponse = await client.post('/login', new URLSearchParams({
        '_token': csrfToken,
        'email': email,
        'password': password
    }));

    const finalUrl = loginResponse.request.res ? loginResponse.request.res.responseUrl : loginResponse.request.path;
    if (finalUrl && finalUrl.endsWith('/login')) {
        throw new Error("Credenciales inválidas");
    }
}

// Endpoint para obtener credenciales guardadas (enmascarando contraseñas)
app.get('/api/config/credentials', (req, res) => {
    const creds = getSavedCredentials();
    const hasVentas = !!(creds.ventasEmail && creds.ventasPassword);
    const hasAlmacen = !!(creds.almacenEmail && creds.almacenPassword);
    res.json({
        success: true,
        configured: hasVentas && hasAlmacen,
        ventasEmail: creds.ventasEmail || "",
        almacenEmail: creds.almacenEmail || "",
        ventasPassword: creds.ventasPassword ? "••••••••" : "",
        almacenPassword: creds.almacenPassword ? "••••••••" : ""
    });
});

// Endpoint para guardar credenciales
app.post('/api/config/credentials', (req, res) => {
    const { ventasEmail, ventasPassword, almacenEmail, almacenPassword } = req.body;
    const creds = getSavedCredentials();

    if (ventasEmail !== undefined) creds.ventasEmail = ventasEmail;
    if (ventasPassword !== undefined && ventasPassword !== "••••••••" && ventasPassword !== "") {
        creds.ventasPassword = ventasPassword;
    }

    if (almacenEmail !== undefined) creds.almacenEmail = almacenEmail;
    if (almacenPassword !== undefined && almacenPassword !== "••••••••" && almacenPassword !== "") {
        creds.almacenPassword = almacenPassword;
    }

    saveSavedCredentials(creds);
    res.json({ success: true, message: "Configuración guardada correctamente." });
});


// Ruta para activar la sincronización
app.get('/api/update-catalog', (req, res) => {
    console.log("🚀 Iniciando actualización manual desde la web...");

    const creds = getSavedCredentials();
    if (!creds.almacenEmail || !creds.almacenPassword) {
        return res.status(400).json({ success: false, message: "Faltan configurar las credenciales de Almacén." });
    }

    const env = { ...process.env, API_EMAIL: creds.almacenEmail, API_PASSWORD: creds.almacenPassword };
    exec('node scripts/extraer_auto.js && node scripts/import.js && node scripts/update_warehouses.js', { env }, (error, stdout, stderr) => {
        if (error) {
            console.error(`❌ Error: ${error.message}`);
            return res.status(500).json({ success: false, message: error.message });
        }
        console.log(`✅ Resultado: ${stdout}`);
        res.json({ success: true, message: "Catálogo actualizado exitosamente." });
    });
});

app.get('/api/update-movimientos', (req, res) => {
    console.log("🚀 Iniciando extracción de movimientos...");

    const creds = getSavedCredentials();
    if (!creds.almacenEmail || !creds.almacenPassword) {
        return res.status(400).json({ success: false, message: "Faltan configurar las credenciales de Almacén." });
    }

    const env = { ...process.env, API_EMAIL: creds.almacenEmail, API_PASSWORD: creds.almacenPassword };
    exec('node scripts/extraer_movimiento.js && node scripts/update_warehouses.js', { env }, (error, stdout, stderr) => {
        if (stdout) console.log(`[Movimientos stdout]:\n${stdout}`);
        if (stderr) console.error(`[Movimientos stderr]:\n${stderr}`);

        if (error) {
            console.error(`❌ Error: ${error.message}`);
            return res.status(500).json({ success: false, message: error.message });
        }
        res.json({ success: true, message: "Movimientos actualizados." });
        console.log("🚀 Movimientos actualizados exitosamente.");
    });
});

app.get('/api/movimientos', async (req, res) => {
    try {
        const warehouses = await prisma.warehouse.findMany();
        const aliasMap = {};
        warehouses.forEach(w => {
            if (w.alias) aliasMap[w.name.toLowerCase()] = w.alias;
        });

        const filePath = path.join(__dirname, 'data', 'movimiento.json');
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(data);
            const dataArray = parsed.data ? parsed.data : parsed;

            // Deduplicar movimientos por combinación única de item_internal_id y warehouse_description
            const seen = new Set();
            const deduplicated = [];
            for (const p of dataArray) {
                if (!p.item_internal_id) continue;
                const key = `${p.item_internal_id}-${(p.warehouse_description || 'Principal').toLowerCase()}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    const wDescLower = (p.warehouse_description || '').toLowerCase();
                    if (aliasMap[wDescLower]) {
                        p.warehouse_description = aliasMap[wDescLower];
                    }
                    deduplicated.push(p);
                }
            }
            res.json(deduplicated);
        } else {
            res.json([]);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Añade esto a tu archivo server.js actual
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Ruta para obtener los productos para la tabla
app.get('/api/products', async (req, res) => {
    try {
        // Extraer reservas actuales usando findMany
        const reservedItems = await prisma.quotationItem.findMany({
            where: { quotation: { status: 'RESERVADO' } }
        });

        const reservationMap = {};
        reservedItems.forEach(item => {
            reservationMap[item.productId] = (reservationMap[item.productId] || 0) + item.quantity;
        });

        // Obtener la configuración de almacén de origen de cada producto
        const dbProducts = await prisma.product.findMany({
            select: { internal_id: true, originWarehouse: true }
        });
        const originMap = {};
        dbProducts.forEach(p => {
            if (p.originWarehouse) originMap[p.internal_id] = p.originWarehouse;
        });

        // Obtener el diccionario de alias de almacenes para hacer coincidir
        const warehouses = await prisma.warehouse.findMany();
        const aliasMap = {};
        warehouses.forEach(w => {
            aliasMap[w.name.toLowerCase()] = w.alias || (w.name.includes(' - ') ? w.name.split(' - ')[1].trim() : w.name);
        });

        const jsonPath = path.join(__dirname, 'data', 'product.json');
        let useJson = false;
        let dataArray = [];
        if (fs.existsSync(jsonPath)) {
            try {
                const rawData = fs.readFileSync(jsonPath, 'utf8');
                const parsedData = JSON.parse(rawData);
                if (Array.isArray(parsedData) && parsedData.length > 0) {
                    // Deduplicar productos por combinación única de internal_id y warehouse_name
                    const seen = new Set();
                    const deduplicated = [];
                    for (const p of parsedData) {
                        if (!p.internal_id) continue;
                        const key = `${p.internal_id}-${(p.warehouse_name || 'Principal').toLowerCase()}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            deduplicated.push(p);
                        }
                    }

                    // -- INYECTAR PRODUCTOS FALTANTES DESDE MOVIMIENTOS --
                    // Así Inventario tendrá exactamente los mismos datos que Movimientos
                    const movPath = path.join(__dirname, 'data', 'movimiento.json');
                    if (fs.existsSync(movPath)) {
                        try {
                            const movData = JSON.parse(fs.readFileSync(movPath, 'utf8'));
                            const movArray = movData.data ? movData.data : movData;
                            for (const m of movArray) {
                                if (!m.item_internal_id) continue;
                                const mKey = `${m.item_internal_id}-${(m.warehouse_description || 'Principal').toLowerCase()}`;
                                if (!seen.has(mKey)) {
                                    seen.add(mKey);
                                    deduplicated.push({
                                        internal_id: m.item_internal_id,
                                        name: m.item_description,
                                        item_category_name: 'Sin Categoría',
                                        stock: m.stock || 0,
                                        warehouse_name: m.warehouse_description
                                    });
                                }
                            }
                        } catch(e) {}
                    }
                    // -----------------------------------------------------

                    dataArray = deduplicated;
                    useJson = true;
                }
            } catch (e) {
                console.error("Error reading product.json:", e);
            }
        }

        if (useJson) {
            // Agrupar filas por internal_id
            const productsById = {};
            dataArray.forEach(p => {
                const wNameLower = (p.warehouse_name || '').toLowerCase();
                if (aliasMap[wNameLower]) {
                    p.warehouse_name = aliasMap[wNameLower];
                }
                
                if (!productsById[p.internal_id]) productsById[p.internal_id] = [];
                p.reserva = 0;
                p.stockDiferencia = p.stock;
                productsById[p.internal_id].push(p);
            });

            // Asignar reserva según el almacén de origen
            for (const [internal_id, resQ] of Object.entries(reservationMap)) {
                if (resQ > 0 && productsById[internal_id]) {
                    const rows = productsById[internal_id];
                    const originAlias = originMap[internal_id];
                    let targetRow = null;

                    if (originAlias) {
                        targetRow = rows.find(r => {
                            const alias = aliasMap[r.warehouse_name] || (r.warehouse_name.includes(' - ') ? r.warehouse_name.split(' - ')[1].trim() : r.warehouse_name);
                            return alias.toLowerCase() === originAlias.toLowerCase();
                        });
                    }

                    if (targetRow) {
                        targetRow.reserva += resQ;
                        targetRow.stockDiferencia = targetRow.stock - targetRow.reserva;
                    } else {
                        // Fallback: si no hay origen, asignar a la fila con más stock que NO sea Ventas
                        let fallbackRows = rows.filter(r => {
                            const wName = r.warehouse_name ? r.warehouse_name.toLowerCase() : '';
                            return !wName.includes('ventas');
                        });

                        // Si por algún motivo todos son de ventas, usamos todos (fallback extremo)
                        if (fallbackRows.length === 0) {
                            fallbackRows = rows;
                        }

                        fallbackRows.sort((a, b) => b.stock - a.stock);
                        fallbackRows[0].reserva += resQ;
                        fallbackRows[0].stockDiferencia = fallbackRows[0].stock - fallbackRows[0].reserva;
                    }
                }
            }

            res.setHeader('Content-Type', 'application/json');
            return res.send(JSON.stringify(dataArray));
        } else {
            // Fallback base de datos completo y mapeado para DataTable
            const allDbProducts = await prisma.product.findMany({
                orderBy: { name: 'asc' }
            });
            const mappedProducts = allDbProducts.map(p => {
                const resQ = reservationMap[p.internal_id] || 0;
                return {
                    internal_id: p.internal_id,
                    name: p.name,
                    item_category_name: p.category || 'Sin Categoría',
                    stock: p.stock || 0,
                    reserva: resQ,
                    stockDiferencia: p.stock - resQ,
                    warehouse_name: p.warehouse || 'Principal'
                };
            });
            res.setHeader('Content-Type', 'application/json');
            return res.send(JSON.stringify(mappedProducts));
        }
    } catch (error) {
        console.error("❌ Error:", error);
        res.status(500).json({ error: "Error al obtener productos" });
    }
});

// Ruta para catálogo de productos (Orígenes)
app.get('/api/catalog', async (req, res) => {
    try {
        const products = await prisma.product.findMany({
            orderBy: { name: 'asc' }
        });
        res.json(products);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Ruta para actualizar origen de producto
app.put('/api/catalog/:internal_id/origin', async (req, res) => {
    const user = getUser(req);
    if (!user) return res.status(401).json({ success: false, error: "Sesión no válida" });

    const { internal_id } = req.params;
    const { originWarehouse } = req.body;
    try {
        const updated = await prisma.product.update({
            where: { internal_id },
            data: { originWarehouse: originWarehouse || null }
        });
        res.json({ success: true, product: updated });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Ruta para importación masiva de orígenes
app.post('/api/catalog/import-origins', async (req, res) => {
    const { items } = req.body;
    if (!Array.isArray(items)) {
        return res.status(400).json({ success: false, error: "Datos de importación inválidos." });
    }

    try {
        let updatedCount = 0;
        for (const item of items) {
            const { internal_id, originWarehouse } = item;
            if (internal_id) {
                // Verificar si existe el producto para evitar fallar
                const exists = await prisma.product.findUnique({
                    where: { internal_id: String(internal_id) }
                });
                if (exists) {
                    await prisma.product.update({
                        where: { internal_id: String(internal_id) },
                        data: { originWarehouse: originWarehouse || null }
                    });
                    updatedCount++;
                }
            }
        }
        res.json({ success: true, message: `Se actualizaron los orígenes de ${updatedCount} productos.` });
    } catch (e) {
        console.error("Error al importar orígenes:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Ruta para agregar una cotización específica
app.post('/api/add-quotation', (req, res) => {
    const { quotationNumber } = req.body;

    // Validar el formato
    if (!quotationNumber || !/^\d+$/.test(quotationNumber)) {
        return res.status(400).json({ success: false, error: "Número de cotización no válido." });
    }

    console.log(`🚀 Iniciando extracción de cotización ${quotationNumber}...`);

    const creds = getSavedCredentials();
    if (!creds.ventasEmail || !creds.ventasPassword) {
        return res.status(400).json({ success: false, error: "Faltan configurar las credenciales de Ventas/Administrador." });
    }

    const env = { ...process.env, API_EMAIL: creds.ventasEmail, API_PASSWORD: creds.ventasPassword };

    exec(`node scripts/extraer_cotizacion.js ${quotationNumber}`, { env }, (error, stdout, stderr) => {
        if (stdout) console.log(`[Script stdout]:\n${stdout}`);
        if (stderr) console.error(`[Script stderr]:\n${stderr}`);

        if (error) {
            console.error(`❌ Error: ${error.message}`);

            // Extraer el mensaje específico del error
            let userError = "Error interno al extraer la cotización o credenciales inválidas.";
            if (stdout.includes("El usuario no tiene permisos")) {
                userError = "No tienes permisos para ver esta cotización.";
            } else if (stdout.includes("Cotización no encontrada")) {
                userError = "La cotización no existe o no se puede acceder.";
            } else if (stdout.includes("Credenciales invalidas") || error.message.includes("Credenciales invalidas")) {
                userError = "Credenciales de Ventas/Administrador vencidas o incorrectas.";
            }

            return res.status(500).json({ success: false, error: userError });
        }
        res.json({ success: true, message: `Cotización ${quotationNumber} agregada correctamente.` });
    });
});

// Ruta para sincronizar facturas de forma masiva
app.post('/api/sync-invoices', async (req, res) => {
    console.log("🚀 Iniciando sincronización masiva de facturas...");

    const creds = getSavedCredentials();
    if (!creds.ventasEmail || !creds.ventasPassword) {
        return res.status(400).json({ success: false, error: "Faltan configurar las credenciales de Ventas/Administrador." });
    }

    const env = { ...process.env, API_EMAIL: creds.ventasEmail, API_PASSWORD: creds.ventasPassword };

    exec('node scripts/sync_facturados.js', { env }, (error, stdout, stderr) => {
        if (stdout) console.log(`[Sync stdout]:\n${stdout}`);
        if (stderr) console.error(`[Sync stderr]:\n${stderr}`);

        if (error) {
            console.error(`❌ Error en sincronización: ${error.message}`);
            return res.status(500).json({ success: false, error: "Error al sincronizar facturas. Verifica las credenciales de Ventas." });
        }

        const match = stdout.match(/FACTURADO:\s(\d+)/);
        const updatedCount = match ? match[1] : 0;

        res.json({ success: true, updatedCount });
    });
});

// --- ENDPOINTS PARA COTIZACIONES POR CLIENTE ---

// Obtener registros importados de cotizaciones por cliente
app.get('/api/customer-quotations', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'data', 'customer_quotations.json');
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf-8');
            return res.json(JSON.parse(data));
        }
        res.json([]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Obtener progreso de la importación
app.get('/api/import-customer-progress', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'scripts', 'import_progress.json');
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf-8');
            return res.json(JSON.parse(data));
        }
        res.json({ status: "idle", message: "Listo para iniciar." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Iniciar importación de cotizaciones de cliente de forma asíncrona
app.post('/api/import-customer-quotations', (req, res) => {
    const { query } = req.body;
    if (!query || query.trim() === "") {
        return res.status(400).json({ success: false, error: "Debes proporcionar un nombre o RUC de cliente." });
    }

    const creds = getSavedCredentials();
    if (!creds.ventasEmail || !creds.ventasPassword) {
        return res.status(400).json({ success: false, error: "Faltan configurar las credenciales de Ventas/Administrador." });
    }

    const progressPath = path.join(__dirname, 'scripts', 'import_progress.json');
    fs.writeFileSync(progressPath, JSON.stringify({ status: "running", current: 0, total: 0, currentQuotation: "", message: "🕵️ Iniciando..." }, null, 2));

    const env = { ...process.env, API_EMAIL: creds.ventasEmail, API_PASSWORD: creds.ventasPassword };

    // Ejecutar en segundo plano asíncronamente
    exec(`node scripts/extraer_cotizaciones_cliente.js "${query}"`, { env }, (error, stdout, stderr) => {
        if (stdout) console.log(`[Customer Quotations Script stdout]:\n${stdout}`);
        if (stderr) console.error(`[Customer Quotations Script stderr]:\n${stderr}`);
        if (error) {
            console.error(`❌ Error en script de cotizaciones de cliente: ${error.message}`);
            fs.writeFileSync(progressPath, JSON.stringify({ status: "error", message: `❌ Error: ${error.message}` }, null, 2));
        }
    });

    res.json({ success: true, message: "Importación iniciada en segundo plano." });
});

// Limpiar registros o un cliente en específico
app.delete('/api/customer-quotations', (req, res) => {
    const user = getUser(req);
    if (!user) return res.status(401).json({ success: false, error: "Sesión no válida" });

    const { customer_name } = req.body;
    const filePath = path.join(__dirname, 'data', 'customer_quotations.json');

    try {
        if (!fs.existsSync(filePath)) {
            return res.json({ success: true, message: "No había registros para eliminar." });
        }

        if (customer_name) {
            // Eliminar solo las de ese cliente
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const filtered = data.filter(r => r.customer_name.toLowerCase() !== customer_name.toLowerCase());
            fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2));
            res.json({ success: true, message: `Registros de ${customer_name} eliminados correctamente.` });
        } else {
            // Eliminar archivo por completo
            fs.writeFileSync(filePath, JSON.stringify([], null, 2));
            res.json({ success: true, message: "Todos los registros por cliente se eliminaron." });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint para revisar y extraer una cotización individual de Volper Seal
app.get('/api/review-quotation/:number', async (req, res) => {
    let number = req.params.number.trim();
    if (!number.startsWith('COT-')) {
        number = 'COT-' + number;
    }

    try {
        const creds = getSavedCredentials();
        const email = creds.ventasEmail;
        const password = creds.ventasPassword;

        if (!email || !password) {
            return res.status(400).json({ error: "Faltan configurar las credenciales de Ventas/Administrador." });
        }

        // Asegurar login con las credenciales de ventas
        await login(email, password);

        // Extraer la parte numérica para usarla directamente como ID (ej: "COT-1525" o "1525" -> "1525")
        const quotId = number.replace(/\D/g, '');
        if (!quotId) {
            return res.status(400).json({ error: "El formato de número de cotización no es válido." });
        }

        // Obtener el detalle de la cotización directamente por su ID numérico
        const detailResponse = await client.get(`/quotations/record/${quotId}`);
        
        if (typeof detailResponse.data === 'string' && detailResponse.data.includes('<html')) {
            throw new Error("Sesión expirada o denegada en Volper Seal.");
        }

        const detail = detailResponse.data.data;

        if (!detail || !detail.quotation) {
            return res.status(404).json({ error: `No se encontró la cotización ${number} en el servidor.` });
        }

        let documentRef = "";
        if (detail.documents && detail.documents.length > 0) {
            documentRef = detail.documents[0].number_full;
        } else if (detail.sale_notes && detail.sale_notes.length > 0) {
            documentRef = detail.sale_notes[0].number_full;
        } else if (detail.quotation && detail.quotation.documents && detail.quotation.documents.length > 0) {
            documentRef = detail.quotation.documents[0].number_full;
        } else if (detail.quotation && detail.quotation.sale_notes && detail.quotation.sale_notes.length > 0) {
            documentRef = detail.quotation.sale_notes[0].number_full;
        }

        const isBilled = documentRef ? true : false;

        const items = [];
        if (detail.quotation.items) {
            detail.quotation.items.forEach(line => {
                items.push({
                    customer_name: detail.quotation.customer.name || "Sin nombre",
                    customer_number: detail.quotation.customer.number || "Sin número",
                    number_full: detail.number_full,
                    date_of_issue: detail.date_of_issue,
                    internal_id: line.item.internal_id || "SIN-CODIGO",
                    item_description: line.item.description || "Sin descripción",
                    quantity: parseFloat(line.quantity) || 0,
                    sale_unit_price: parseFloat(line.item.sale_unit_price) || 0,
                    unit_price: parseFloat(line.unit_price) || 0,
                    total: parseFloat(line.total) || 0,
                    is_billed: isBilled,
                    document_ref: documentRef
                });
            });
        }

        // Guardar asíncronamente en customer_quotations.json para actualizar el historial local
        const filePath = path.join(__dirname, 'data', 'customer_quotations.json');
        let existingRecords = [];
        if (fs.existsSync(filePath)) {
            try {
                existingRecords = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (e) {}
        }

        const mergedMap = {};
        existingRecords.forEach(r => {
            const key = `${r.number_full}-${r.internal_id}`;
            mergedMap[key] = r;
        });

        items.forEach(r => {
            const key = `${r.number_full}-${r.internal_id}`;
            mergedMap[key] = r;
        });

        fs.writeFileSync(filePath, JSON.stringify(Object.values(mergedMap), null, 2));

        res.json({
            success: true,
            number_full: detail.number_full,
            date_of_issue: detail.date_of_issue,
            customer_name: detail.quotation.customer.name,
            customer_number: detail.quotation.customer.number,
            items: items
        });

    } catch (e) {
        console.error("Error al revisar cotización:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// Obtener todas las cotizaciones (sin los items, para que sea rápido)
app.get('/api/quotations', async (req, res) => {
    try {
        const quotations = await prisma.quotation.findMany({
            orderBy: { createdAt: 'desc' }
        });
        res.json(quotations);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Ruta para eliminar una cotización
app.delete('/api/quotations/:number', async (req, res) => {
    const user = getUser(req);
    if (!user) return res.status(401).json({ success: false, error: "Sesión no válida" });

    const { number } = req.params;
    const fullNumber = number.includes('COT-') ? number : `COT-${number}`;

    try {
        const quotation = await prisma.quotation.findUnique({ where: { number: fullNumber } });
        if (!quotation) {
            return res.status(404).json({ success: false, error: "Cotización no encontrada en el sistema local." });
        }

        // Primero borramos los items asociados (QuotationItem)
        await prisma.quotationItem.deleteMany({
            where: { quotationId: quotation.id }
        });

        // Luego borramos la cotización (Quotation)
        await prisma.quotation.delete({
            where: { id: quotation.id }
        });

        res.json({ success: true, message: `Cotización ${fullNumber} eliminada correctamente.` });
    } catch (error) {
        console.error("Error al eliminar cotización:", error);
        res.status(500).json({ success: false, error: "Error interno al eliminar la cotización." });
    }
});

// Ruta para cambiar estado de cotización
app.put('/api/quotations/:id/status', async (req, res) => {
    const user = getUser(req);
    if (!user) return res.status(401).json({ success: false, error: "Sesión no válida" });

    const { id } = req.params;
    const { status } = req.body;

    if (!['PENDIENTE', 'RESERVADO', 'FACTURADO'].includes(status)) {
        return res.status(400).json({ success: false, error: "Estado no válido" });
    }

    try {
        const updated = await prisma.quotation.update({
            where: { id },
            data: { status }
        });
        res.json({ success: true, quotation: updated });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Ruta para obtener almacenes
app.get('/api/warehouses', async (req, res) => {
    try {
        const warehouses = await prisma.warehouse.findMany({
            orderBy: { id: 'asc' }
        });
        res.json(warehouses);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Ruta para actualizar el alias de un almacén
app.put('/api/warehouses/:id', async (req, res) => {
    const user = getUser(req);
    if (!user) return res.status(401).json({ success: false, message: "Sesión no válida" });

    const { id } = req.params;
    const { alias } = req.body;

    try {
        const updated = await prisma.warehouse.update({
            where: { id: parseInt(id) },
            data: { alias }
        });
        res.json({ success: true, warehouse: updated });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Ruta para registrar un ingreso (transaction)
app.post('/api/add-transaction', async (req, res) => {
    const { item_id, warehouse_id, quantity, inventory_transaction_id, comments } = req.body;

    if (!item_id || !warehouse_id || !quantity) {
        return res.status(400).json({ success: false, error: "Faltan datos obligatorios" });
    }

    const creds = getSavedCredentials();
    if (!creds.almacenEmail || !creds.almacenPassword) {
        return res.status(400).json({ success: false, error: "Faltan configurar las credenciales de Almacén." });
    }

    try {
        await login(creds.almacenEmail, creds.almacenPassword);

        // 1. Obtener la página de inventario para capturar el token CSRF actualizado después del login
        const invPage = await client.get('/inventory');
        const $ = cheerio.load(invPage.data);
        const csrfToken = $('meta[name="csrf-token"]').attr('content') || $('input[name="_token"]').val();

        if (!csrfToken) {
            throw new Error("No se pudo obtener el token CSRF de la sesión.");
        }

        const payload = {
            id: null,
            item_id: parseInt(item_id),
            warehouse_id: parseInt(warehouse_id),
            inventory_transaction_id: inventory_transaction_id || "19",
            quantity: parseFloat(quantity),
            type: "input",
            lot_code: null,
            lots_enabled: false,
            series_enabled: false,
            lots: [],
            date_of_due: null,
            created_at: null,
            comments: comments || null
        };

        const response = await client.post('/inventory/transaction', payload, {
            headers: {
                'X-CSRF-TOKEN': csrfToken,
                'X-Requested-With': 'XMLHttpRequest'
            }
        });

        if (response.data && response.data.success !== false) {
            
            // Guardar en Kardex local
            const kardexPath = path.join(__dirname, 'data', 'kardex_ingresos.json');
            let kardexData = [];
            if (fs.existsSync(kardexPath)) {
                try { kardexData = JSON.parse(fs.readFileSync(kardexPath, 'utf8')); } catch(e){}
            }

            const kardexRecord = {
                id: Date.now(),
                date: new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' }),
                item_id,
                item_code: req.body.item_code || '',
                item_description: req.body.item_description || '',
                warehouse_id,
                warehouse_description: req.body.warehouse_description || '',
                initial_stock: parseFloat(req.body.initial_stock) || 0,
                added_quantity: parseFloat(quantity) || 0,
                final_stock: (parseFloat(req.body.initial_stock) || 0) + (parseFloat(quantity) || 0),
                comments: comments || 'Ingreso de Producción'
            };

            kardexData.push(kardexRecord);
            fs.writeFileSync(kardexPath, JSON.stringify(kardexData, null, 2));

            // Actualizar movimiento.json localmente para que persista al dar F5
            const movPath = path.join(__dirname, 'data', 'movimiento.json');
            if (fs.existsSync(movPath)) {
                try {
                    const movRaw = fs.readFileSync(movPath, 'utf8');
                    const movParsed = JSON.parse(movRaw);
                    const movArray = movParsed.data ? movParsed.data : movParsed;
                    
                    const addedQty = parseFloat(quantity) || 0;
                    for (let item of movArray) {
                        if (String(item.item_id) === String(item_id) && String(item.warehouse_id) === String(warehouse_id)) {
                            item.stock = (parseFloat(item.stock) || 0) + addedQty;
                        }
                    }
                    fs.writeFileSync(movPath, JSON.stringify(movParsed, null, 2));
                } catch(e) {
                    console.error("Error updating movimiento.json cache", e);
                }
            }

            // Actualizar product.json localmente
            const prodPath = path.join(__dirname, 'data', 'product.json');
            if (fs.existsSync(prodPath)) {
                try {
                    const dbWarehouses = await prisma.warehouse.findMany();
                    const aliasMap = {};
                    dbWarehouses.forEach(w => {
                        aliasMap[w.name.toLowerCase()] = w.alias || (w.name.includes(' - ') ? w.name.split(' - ')[1].trim() : w.name);
                    });

                    const prodArray = JSON.parse(fs.readFileSync(prodPath, 'utf8'));
                    const addedQty = parseFloat(quantity) || 0;
                    const incomingWDesc = (req.body.warehouse_description || '').toLowerCase();
                    
                    for (let p of prodArray) {
                        const pName = (p.warehouse_name || '').toLowerCase();
                        const mappedName = (aliasMap[pName] || '').toLowerCase();
                        
                        const isMatch = (p.internal_id === req.body.item_code) && 
                            (pName === incomingWDesc || mappedName === incomingWDesc || pName.includes(incomingWDesc));
                        
                        if (isMatch) {
                            p.stock = (parseFloat(p.stock) || 0) + addedQty;
                        }
                    }
                    fs.writeFileSync(prodPath, JSON.stringify(prodArray, null, 2));
                } catch(e) {
                    console.error("Error updating product.json cache", e);
                }
            }

            res.json({ success: true, message: "Ingreso registrado correctamente y guardado en el kardex." });
        } else {
            res.status(400).json({ success: false, error: response.data.message || "Error al registrar ingreso." });
        }
    } catch (error) {
        if (error.message === "Credenciales inválidas") {
            return res.status(401).json({ success: false, error: "Credenciales de Almacén incorrectas o vencidas en Configuración." });
        }
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});
// Ruta para registrar un traslado
app.post('/api/move-transaction', async (req, res) => {
    const { 
        id, item_id, item_code, item_description, warehouse_id, warehouse_description, 
        quantity, warehouse_new_id, quantity_move, quantity_real, 
        lots_enabled, series_enabled, lots, lots_group, detail, target_warehouse_description 
    } = req.body;

    if (!item_id || !warehouse_id || !warehouse_new_id || !quantity_move) {
        return res.status(400).json({ success: false, error: "Faltan datos obligatorios para el traslado" });
    }

    const creds = getSavedCredentials();
    if (!creds.almacenEmail || !creds.almacenPassword) {
        return res.status(400).json({ success: false, error: "Faltan configurar las credenciales de Almacén." });
    }

    try {
        await login(creds.almacenEmail, creds.almacenPassword);

        // Obtener la página de inventario para capturar el token CSRF
        const invPage = await client.get('/inventory');
        const $ = cheerio.load(invPage.data);
        const csrfToken = $('meta[name="csrf-token"]').attr('content') || $('input[name="_token"]').val();

        if (!csrfToken) {
            throw new Error("No se pudo obtener el token CSRF de la sesión.");
        }

        const whFrom = await prisma.warehouse.findUnique({ where: { id: parseInt(warehouse_id) } });
        const realWarehouseDescription = whFrom ? whFrom.name : (warehouse_description || "");

        const payload = {
            id: id || null,
            item_id: parseInt(item_id),
            item_description: item_description || "",
            warehouse_id: parseInt(warehouse_id),
            warehouse_description: realWarehouseDescription,
            quantity: parseFloat(quantity) || 0,
            warehouse_new_id: parseInt(warehouse_new_id),
            quantity_move: String(quantity_move),
            quantity_real: parseFloat(quantity_real) || 0,
            lots_enabled: lots_enabled || false,
            series_enabled: series_enabled || false,
            lots: lots || [],
            lots_group: lots_group || []
        };

        const response = await client.post('/inventory/move', payload, {
            headers: {
                'X-CSRF-TOKEN': csrfToken,
                'X-Requested-With': 'XMLHttpRequest'
            }
        });

        if (response.data && response.data.success !== false) {
            
            // Guardar en Kardex local (Salida del almacén origen)
            const kardexPath = path.join(__dirname, 'data', 'kardex_ingresos.json');
            let kardexData = [];
            if (fs.existsSync(kardexPath)) {
                try { kardexData = JSON.parse(fs.readFileSync(kardexPath, 'utf8')); } catch(e){}
            }

            const kardexRecord = {
                id: Date.now(),
                date: new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' }),
                item_id,
                item_code: item_code || '',
                item_description: item_description || '',
                warehouse_id,
                warehouse_description: warehouse_description || '',
                initial_stock: parseFloat(quantity) || 0,
                added_quantity: -parseFloat(quantity_move), // Negativo porque es una salida por traslado
                final_stock: parseFloat(quantity_real) || 0,
                comments: `Traslado hacia: ${target_warehouse_description || warehouse_new_id} | ${detail || ''}`
            };

            kardexData.push(kardexRecord);
            fs.writeFileSync(kardexPath, JSON.stringify(kardexData, null, 2));

            // Actualizar movimiento.json localmente para que persista al dar F5
            const movPath = path.join(__dirname, 'data', 'movimiento.json');
            if (fs.existsSync(movPath)) {
                try {
                    const movRaw = fs.readFileSync(movPath, 'utf8');
                    const movParsed = JSON.parse(movRaw);
                    const movArray = movParsed.data ? movParsed.data : movParsed;
                    
                    const movedQty = parseFloat(quantity_move) || 0;
                    for (let item of movArray) {
                        // Restar del origen
                        if (String(item.item_id) === String(item_id) && String(item.warehouse_id) === String(warehouse_id)) {
                            item.stock = (parseFloat(item.stock) || 0) - movedQty;
                        }
                        // Sumar al destino
                        if (String(item.item_id) === String(item_id) && String(item.warehouse_id) === String(warehouse_new_id)) {
                            item.stock = (parseFloat(item.stock) || 0) + movedQty;
                        }
                    }
                    fs.writeFileSync(movPath, JSON.stringify(movParsed, null, 2));
                } catch(e) {
                    console.error("Error updating movimiento.json cache for move", e);
                }
            }

            // Actualizar product.json localmente para traslados
            const prodPath = path.join(__dirname, 'data', 'product.json');
            if (fs.existsSync(prodPath)) {
                try {
                    const dbWarehouses = await prisma.warehouse.findMany();
                    const aliasMap = {};
                    dbWarehouses.forEach(w => {
                        aliasMap[w.name.toLowerCase()] = w.alias || (w.name.includes(' - ') ? w.name.split(' - ')[1].trim() : w.name);
                    });

                    const prodArray = JSON.parse(fs.readFileSync(prodPath, 'utf8'));
                    const movedQty = parseFloat(quantity_move) || 0;
                    const fromDesc = (warehouse_description || '').toLowerCase();
                    const toDesc = (target_warehouse_description || '').toLowerCase();

                    for (let p of prodArray) {
                        const pName = (p.warehouse_name || '').toLowerCase();
                        const mappedName = (aliasMap[pName] || '').toLowerCase();
                        
                        // Restar origen
                        if (p.internal_id === item_code && (pName === fromDesc || mappedName === fromDesc || pName.includes(fromDesc))) {
                            p.stock = (parseFloat(p.stock) || 0) - movedQty;
                        }
                        // Sumar destino
                        if (p.internal_id === item_code && (pName === toDesc || mappedName === toDesc || pName.includes(toDesc))) {
                            p.stock = (parseFloat(p.stock) || 0) + movedQty;
                        }
                    }
                    fs.writeFileSync(prodPath, JSON.stringify(prodArray, null, 2));
                } catch(e) {
                    console.error("Error updating product.json cache for move", e);
                }
            }

            res.json({ success: true, message: "Traslado registrado correctamente y guardado en el kardex." });
        } else {
            res.status(400).json({ success: false, error: response.data.message || "Error al registrar traslado." });
        }
    } catch (error) {
        if (error.message === "Credenciales inválidas") {
            return res.status(401).json({ success: false, error: "Credenciales de Almacén incorrectas." });
        }
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint para obtener el Kardex de ingresos
app.get('/api/kardex', (req, res) => {
    const kardexPath = path.join(__dirname, 'data', 'kardex_ingresos.json');
    if (fs.existsSync(kardexPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(kardexPath, 'utf8'));
            res.json(data);
        } catch (e) {
            res.status(500).json({ error: "Error leyendo el archivo kardex" });
        }
    } else {
        res.json([]);
    }
});

// Permite que la web consulte los datos de la cotización
app.get('/api/quotations/:number', async (req, res) => {
    try {
        const { number } = req.params;

        // Buscamos la cotización y usamos el internal_id para traer el stock de la tabla Product
        const quotation = await prisma.quotation.findUnique({
            where: { number: number },
            include: { items: true }
        });

        if (!quotation) return res.status(404).json({ error: "Cotización no encontrada" });

        // Calcular reservas globales
        const reservedItems = await prisma.quotationItem.findMany({
            where: { quotation: { status: 'RESERVADO' } }
        });
        const reservationMap = {};
        reservedItems.forEach(item => {
            reservationMap[item.productId] = (reservationMap[item.productId] || 0) + item.quantity;
        });

        // Obtener todos los almacenes de la BD para identificar cuáles son "Ventas" (y excluirlos)
        const dbWarehouses = await prisma.warehouse.findMany();
        const ventasNames = dbWarehouses
            .filter(w => {
                const aliasLower = (w.alias || '').toLowerCase();
                const nameLower = (w.name || '').toLowerCase();
                return aliasLower === 'ventas' || nameLower.includes('principal') || nameLower.includes('ventas');
            })
            .map(w => w.name);

        // Por si acaso, si no hay almacenes registrados en la BD local, usamos el por defecto de Ventas
        if (ventasNames.length === 0) {
            ventasNames.push("Almacén - Almacén principal");
        }

        // Obtener orígenes configurados en la BD
        const allDbProducts = await prisma.product.findMany({ select: { internal_id: true, originWarehouse: true } });
        const originMap = {};
        allDbProducts.forEach(p => {
            if (p.originWarehouse) originMap[p.internal_id] = p.originWarehouse;
        });

        const aliasMap = {};
        dbWarehouses.forEach(w => {
            aliasMap[w.name] = w.alias || (w.name.includes(' - ') ? w.name.split(' - ')[1].trim() : w.name);
        });

        const jsonPath = path.join(__dirname, 'data', 'product.json');
        const movPath = path.join(__dirname, 'data', 'movimiento.json');
        const stockMap = {};

        // Función auxiliar para procesar items
        const processItem = (internal_id, stock, whName) => {
            const originAlias = originMap[internal_id];
            
            if (originAlias) {
                // Si tiene origen definido, SOLO sumar de ese almacén
                const alias = aliasMap[whName] || (whName.includes(' - ') ? whName.split(' - ')[1].trim() : whName);
                if (alias.toLowerCase() === originAlias.toLowerCase()) {
                    stockMap[internal_id] = (stockMap[internal_id] || 0) + stock;
                }
            } else {
                // Si NO tiene origen definido, sumar de cualquier almacén que NO sea ventas/principal
                const isVentas = ventasNames.some(vn => vn.toLowerCase() === whName.toLowerCase()) ||
                    whName.toLowerCase().includes('principal') ||
                    whName.toLowerCase().includes('ventas');
                
                if (!isVentas) {
                    stockMap[internal_id] = (stockMap[internal_id] || 0) + stock;
                }
            }
        };

        if (fs.existsSync(jsonPath)) {
            try {
                // Procesar product.json
                const dataArray = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                dataArray.forEach(p => processItem(p.internal_id, p.stock || 0, p.warehouse_name || ''));
                
                // Procesar movimiento.json para los productos faltantes (igual que en /api/products)
                if (fs.existsSync(movPath)) {
                    const movData = JSON.parse(fs.readFileSync(movPath, 'utf8'));
                    const movArray = movData.data ? movData.data : movData;
                    movArray.forEach(m => {
                        if (m.item_internal_id) {
                            processItem(m.item_internal_id, m.stock || 0, m.warehouse_description || '');
                        }
                    });
                }
            } catch(e) { console.error("Error leyendo JSONs para stock:", e); }
        } else {
            allDbProducts.forEach(p => {
                processItem(p.internal_id, p.stock || 0, p.warehouse || '');
            });
        }

        // Mapeamos los items para calcular su estado real
        const itemsSincerados = quotation.items.map(item => {
            const stockTotal = stockMap[item.productId] || 0;
            const reservaGlobal = reservationMap[item.productId] || 0;
            const stockDispGlobal = stockTotal - reservaGlobal;

            // Si esta cotización YA ESTÁ reservada, su cantidad es parte de "reservaGlobal",
            // así que para evaluar si se puede cumplir, "le devolvemos" su propia cantidad al disponible
            const miReserva = (quotation.status === 'RESERVADO') ? item.quantity : 0;
            const stockDisponibleParaMi = stockDispGlobal + miReserva;

            return {
                ...item,
                stockTotal,
                reservaGlobal,
                stockDispGlobal,
                stockDisponibleParaMi
            };
        });

        res.json({ ...quotation, items: itemsSincerados });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`🌐 Servidor de Volper Seal corriendo en http://localhost:${port}`);
});
