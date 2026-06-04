const { exec } = require('child_process');
const { getSavedCredentials } = require('../utils/credentials');

exports.syncInvoices = async (req, res) => {
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
};
