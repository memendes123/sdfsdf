require('dotenv').config();

const panelUser = process.env.PANEL_USERNAME ?? process.env.PANEL_USER;
const panelPass = process.env.PANEL_PASSWORD ?? process.env.PANEL_PASS;

if (!panelUser || !panelPass) {
    console.warn('[Painel] Credenciais do painel não configuradas (PANEL_USERNAME/PANEL_PASSWORD).');
}

module.exports = function auth(user) {
    return Boolean(
        user &&
        panelUser &&
        panelPass &&
        user.name === panelUser &&
        user.pass === panelPass
    );
};
