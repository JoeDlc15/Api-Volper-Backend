const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { client, login } = require('../services/volperService');
const { getSavedCredentials } = require('../utils/credentials');

exports.updateCatalog = (req, res) => {
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
};

exports.updateMovimientos = (req, res) => {
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
};

exports.getMovimientos = async (req, res) => {
    try {
        const warehouses = await prisma.warehouse.findMany();
        const aliasMap = {};
        warehouses.forEach(w => {
            if (w.alias) aliasMap[w.name.toLowerCase()] = w.alias;
        });

        const filePath = path.join(__dirname, '../../data', 'movimiento.json');
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
};

exports.getLastUpdates = (req, res) => {
    try {
        const metaPath = path.join(__dirname, '../../data', 'metadata.json');
        const productPath = path.join(__dirname, '../../data', 'product.json');
        const movPath = path.join(__dirname, '../../data', 'movimiento.json');
        
        let catalogDate = null;
        let movDate = null;

        if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            catalogDate = meta.catalog || null;
            movDate = meta.movimientos || null;
        }

        // Fallback
        if (!catalogDate && fs.existsSync(productPath)) catalogDate = fs.statSync(productPath).mtime;
        if (!movDate && fs.existsSync(movPath)) movDate = fs.statSync(movPath).mtime;

        res.json({ catalog: catalogDate, movimientos: movDate });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

exports.getProducts = async (req, res) => {
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

        const jsonPath = path.join(__dirname, '../../data', 'product.json');
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
                    const movPath = path.join(__dirname, '../../data', 'movimiento.json');
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
};

exports.getCatalog = async (req, res) => {
    try {
        const products = await prisma.product.findMany({
            orderBy: { name: 'asc' }
        });
        res.json(products);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

exports.updateOrigin = async (req, res) => {
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
};

exports.importOrigins = async (req, res) => {
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
};

exports.getWarehouses = async (req, res) => {
    try {
        const warehouses = await prisma.warehouse.findMany({
            orderBy: { id: 'asc' }
        });
        res.json(warehouses);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

exports.updateWarehouse = async (req, res) => {
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
};

exports.addTransaction = async (req, res) => {
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
            const kardexPath = path.join(__dirname, '../../data', 'kardex_ingresos.json');
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
            const movPath = path.join(__dirname, '../../data', 'movimiento.json');
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
            const prodPath = path.join(__dirname, '../../data', 'product.json');
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
};

exports.moveTransaction = async (req, res) => {
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
            const kardexPath = path.join(__dirname, '../../data', 'kardex_ingresos.json');
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
            const movPath = path.join(__dirname, '../../data', 'movimiento.json');
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
            const prodPath = path.join(__dirname, '../../data', 'product.json');
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
};

exports.getKardex = (req, res) => {
    const kardexPath = path.join(__dirname, '../../data', 'kardex_ingresos.json');
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
};

