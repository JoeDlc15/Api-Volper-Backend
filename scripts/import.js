const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

async function main() {
  console.log('🚀 Iniciando carga de productos a PostgreSQL (Docker)...');

  // 1. Leer el archivo JSON
  // Asegúrate de que tu archivo se llame 'product.json' y esté en la carpeta data
  const jsonPath = path.join(__dirname, '../data/product.json');
  const rawData = fs.readFileSync(jsonPath);
  const productos = JSON.parse(rawData);

  console.log(`📦 Procesando ${productos.length} registros encontrados.`);

  // 2. Bucle de inserción con Upsert
  for (const item of productos) {
    try {
      await prisma.product.upsert({
        // Usamos internal_id como la llave única para no duplicar datos
        where: { internal_id: item.internal_id }, 
        update: {
          stock: parseFloat(item.stock) || 0,
          salePrice: parseFloat(item.sale_unit_price) || 0,
          stockMin: parseFloat(item.stock_min) || 0,
          updatedAt: new Date(),
        },
        create: {
          internal_id: item.internal_id,
          barcode: item.barcode || '',
          name: item.name || 'Sin Nombre',
          description: item.description || '', // Maneja los nulls
          category: item.item_category_name || 'Sin Categoría',
          stock: parseFloat(item.stock) || 0,
          stockMin: parseFloat(item.stock_min) || 0,
          salePrice: parseFloat(item.sale_unit_price) || 0,
          purchasePrice: parseFloat(item.purchase_unit_price) || 0,
          model: item.model || '',
          brand: item.brand_name || '',
          warehouse: item.warehouse_name || 'Principal',
          currency: item.currency_type_id || 'PEN',
        },
      });
    } catch (e) {
      console.error(`❌ Error en item ${item.internal_id}:`, e.message);
    }
  }

  console.log('✅ ¡Importación masiva completada con éxito!');
}

main()
  .catch((e) => {
    console.error('Fallo crítico:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
