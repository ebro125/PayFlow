const express      = require('express');
const errorHandler = require('./middleware/errorHandlers');

const app = express();

app.use(express.json());

// Start the transfer worker
require('./queues/transferWorker');

// Routes
app.use('/api',        require('./routes/index'));
app.use('/api/auth',   require('./routes/auth'));
app.use('/api/wallet', require('./routes/wallet'));

// Central error handler — must be last
app.use(errorHandler);

module.exports = app;