const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.render('client', {
    title: 'Área do Cliente',
    siteName: req.app.locals.siteName,
  });
});

module.exports = router;
