const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());

// Serve your public files
app.use(express.static(path.join(__dirname, '../public')));

// API health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'GIS Wonjuga Portal Live' });
});

// For clean URLs - send all other routes to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`GIS Wonjuga Portal Live on port ${PORT}`);
});