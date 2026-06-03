const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

async function main() {
    console.log('🚀 Iniciando actualización de almacenes...');

    const jsonPath = path.join(__dirname, '../data/movimiento.json');
    if (!fs.existsSync(jsonPath)) {
        console.log('⚠️ No se encontró movimiento.json. Abortando actualización de almacenes.');
        return;
    }

    const rawData = fs.readFileSync(jsonPath);
    const result = JSON.parse(rawData);
    
    // Sometimes the data is wrapped in an object like { data: [...] } (as seen in error1.txt) 
    // or it's a flat array.
    const movimientos = result.data ? result.data : result;

    if (!Array.isArray(movimientos)) {
        console.log('⚠️ Formato de movimiento.json no reconocido.');
        return;
    }

    const warehouseMap = {};

    // Calculate item counts for each warehouse
    for (const mov of movimientos) {
        if (!mov.warehouse_id) continue;
        
        if (!warehouseMap[mov.warehouse_id]) {
            let defaultAlias = mov.warehouse_description || '';
            if (defaultAlias.includes(' - ')) {
                defaultAlias = defaultAlias.split(' - ')[1].trim(); // Extrae lo que va después del guión
            }

            warehouseMap[mov.warehouse_id] = {
                id: mov.warehouse_id,
                name: mov.warehouse_description || 'Desconocido',
                alias: defaultAlias,
                count: 0
            };
        }
        warehouseMap[mov.warehouse_id].count++;
    }

    const totalWarehouses = Object.keys(warehouseMap).length;
    console.log(`📦 Procesando ${totalWarehouses} almacenes encontrados.`);

    for (const key in warehouseMap) {
        const wh = warehouseMap[key];
        try {
            await prisma.warehouse.upsert({
                where: { id: parseInt(wh.id) },
                update: {
                    name: wh.name,
                    itemCount: wh.count
                },
                create: {
                    id: parseInt(wh.id),
                    name: wh.name,
                    itemCount: wh.count,
                    alias: wh.alias
                }
            });
        } catch (e) {
            console.error(`❌ Error actualizando almacén ${wh.id}:`, e.message);
        }
    }

    console.log('✅ ¡Actualización de almacenes completada con éxito!');
}

main()
  .catch((e) => {
    console.error('Fallo crítico:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
