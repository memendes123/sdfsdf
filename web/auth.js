require('dotenv').config();

module.exports = function auth(user) {
    return user && user.name === process.env.PANEL_USER && user.pass === process.env.PANEL_PASS;
};