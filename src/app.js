const express = require('express');
const errorHandler = require('./middleware/errorHandlers');

const app = express();

app.use(express.json());

// Routes
app.use('/api', require('./routes/index'));

// Central error handler — must be last
app.use(errorHandler);

module.exports = app;