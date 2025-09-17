require('dotenv').config();
const express = require('express');
const path = require('path');
const panelRouter = require('./routes/panel');
const userRouter = require('./routes/user');
const clientRouter = require('./routes/client');
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.locals.siteName = 'Rep4Rep Control Center';

app.use('/api/user', userRouter);
app.use('/admin', panelRouter);
app.use('/', clientRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Painel rodando em http://localhost:${PORT}`));
