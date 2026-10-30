// Sign in / out for the web UI, and "who am I" for the shell.
const express = require('express');
const { login, logout, isOwner } = require('../../core/auth');

module.exports = {
  name: 'session',
  mount(app) {
    app.post('/api/login', express.json({ limit: '2kb' }), login);
    app.post('/api/logout', logout);
    app.get('/api/me', (req, res) => res.json({ owner: isOwner(req), writes: Boolean(process.env.HUB_API_TOKEN) }));
  },
};
