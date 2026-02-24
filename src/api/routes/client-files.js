'use strict';

const router = require('express').Router();
const pool = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const UPLOAD_DIR = path.join(__dirname, '..', '..', '..', 'uploads');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (_req, file, cb) => {
    // Block executable files
    const blocked = ['.exe', '.bat', '.cmd', '.sh', '.msi', '.com'];
    if (blocked.includes(path.extname(file.originalname).toLowerCase())) {
      return cb(new Error('File type not allowed'));
    }
    cb(null, true);
  },
});

router.use(requireAuth);

// GET /api/clients/:clientId/files
router.get('/:clientId/files', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT cf.*, o.full_name AS uploaded_by_name
       FROM client_files cf
       LEFT JOIN operators o ON cf.uploaded_by = o.id
       WHERE cf.client_id = $1
       ORDER BY cf.created_at DESC`,
      [req.params.clientId]
    );
    res.json({ files: result.rows });
  } catch (err) { next(err); }
});

// POST /api/clients/:clientId/files
router.post('/:clientId/files', requireRole('admin', 'supervisor'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const result = await pool.query(
      `INSERT INTO client_files (client_id, filename, original_name, mime_type, size_bytes, description, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        req.params.clientId,
        req.file.filename,
        req.file.originalname,
        req.file.mimetype,
        req.file.size,
        req.body.description || null,
        req.operator.id,
      ]
    );
    res.status(201).json({ file: result.rows[0] });
  } catch (err) { next(err); }
});

// GET /api/clients/:clientId/files/:fileId/download
router.get('/:clientId/files/:fileId/download', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM client_files WHERE id = $1 AND client_id = $2',
      [req.params.fileId, req.params.clientId]
    );
    const file = result.rows[0];
    if (!file) return res.status(404).json({ error: 'File not found' });

    const filePath = path.resolve(UPLOAD_DIR, path.basename(file.filename));
    // Ensure resolved path stays within UPLOAD_DIR (path traversal protection)
    if (!filePath.startsWith(path.resolve(UPLOAD_DIR))) {
      return res.status(400).json({ error: 'Invalid file path' });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing from disk' });

    res.download(filePath, file.original_name);
  } catch (err) { next(err); }
});

// DELETE /api/clients/:clientId/files/:fileId
router.delete('/:clientId/files/:fileId', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'DELETE FROM client_files WHERE id = $1 AND client_id = $2 RETURNING filename',
      [req.params.fileId, req.params.clientId]
    );
    if (result.rows[0]) {
      const filePath = path.resolve(UPLOAD_DIR, path.basename(result.rows[0].filename));
      if (filePath.startsWith(path.resolve(UPLOAD_DIR))) {
        try { fs.unlinkSync(filePath); } catch (_) {}
      }
    }
    res.json({ message: 'File deleted' });
  } catch (err) { next(err); }
});

// POST /api/clients/:clientId/logo — upload client logo
const logoUpload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB max for logos
  fileFilter: (_req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];
    if (!allowed.includes(path.extname(file.originalname).toLowerCase())) {
      return cb(new Error('Logo must be an image file (png, jpg, gif, svg, webp)'));
    }
    cb(null, true);
  },
});

router.post('/:clientId/logo', requireRole('admin', 'supervisor'), logoUpload.single('logo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file uploaded' });

    // Delete old logo file if exists
    const old = await pool.query('SELECT logo_url FROM clients WHERE id = $1', [req.params.clientId]);
    if (old.rows[0]?.logo_url) {
      const oldPath = path.resolve(UPLOAD_DIR, path.basename(old.rows[0].logo_url));
      if (oldPath.startsWith(path.resolve(UPLOAD_DIR))) {
        try { fs.unlinkSync(oldPath); } catch (_) {}
      }
    }

    const logoFilename = req.file.filename;
    await pool.query('UPDATE clients SET logo_url = $1 WHERE id = $2', [logoFilename, req.params.clientId]);
    res.json({ logo_url: logoFilename });
  } catch (err) { next(err); }
});

// DELETE /api/clients/:clientId/logo — remove client logo
router.delete('/:clientId/logo', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const old = await pool.query('SELECT logo_url FROM clients WHERE id = $1', [req.params.clientId]);
    if (old.rows[0]?.logo_url) {
      const oldPath = path.resolve(UPLOAD_DIR, path.basename(old.rows[0].logo_url));
      if (oldPath.startsWith(path.resolve(UPLOAD_DIR))) {
        try { fs.unlinkSync(oldPath); } catch (_) {}
      }
    }
    await pool.query('UPDATE clients SET logo_url = NULL WHERE id = $1', [req.params.clientId]);
    res.json({ message: 'Logo removed' });
  } catch (err) { next(err); }
});

module.exports = router;
