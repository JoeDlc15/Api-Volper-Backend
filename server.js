const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Importar Rutas
const configRoutes = require('./src/routes/config.routes');
const quotationsRoutes = require('./src/routes/quotations.routes');
const inventoryRoutes = require('./src/routes/inventory.routes');
const invoicesRoutes = require('./src/routes/invoices.routes');

// Montar Rutas
app.use('/api/config', configRoutes);
app.use('/api', quotationsRoutes);
app.use('/api', inventoryRoutes);
app.use('/api', invoicesRoutes);

app.listen(port, () => {
    console.log(`🌐 Servidor de Volper Seal corriendo en http://localhost:${port}`);
});
