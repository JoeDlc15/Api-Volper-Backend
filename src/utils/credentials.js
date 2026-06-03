const fs = require('fs');
const path = require('path');

const credPath = path.join(__dirname, '../../data/credentials.json');

function getSavedCredentials() {
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
    fs.writeFileSync(credPath, JSON.stringify(creds, null, 4));
}

// Bypasseamos el control de sesión ya que la app corre localmente sin login
function getUser() {
    return { email: "config@config.com" };
}

module.exports = {
    getSavedCredentials,
    saveSavedCredentials,
    getUser
};
