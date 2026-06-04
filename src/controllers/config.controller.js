const { getSavedCredentials, saveSavedCredentials } = require('../utils/credentials');

exports.getCredentials = (req, res) => {
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
};

exports.saveCredentials = (req, res) => {
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
};
