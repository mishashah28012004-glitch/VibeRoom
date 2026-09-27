require('dotenv').config();
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET;

if (!SECRET || SECRET === 'change_this_to_a_long_random_secret_string') {
  throw new Error('Set JWT_SECRET to a unique value in the environment before starting the server.');
}

function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: '12h' });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = { signToken, verifyToken, authMiddleware };
