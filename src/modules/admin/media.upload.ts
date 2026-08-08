import multer from 'multer';
import path from 'path';
import fs from 'fs';

const UPLOADS_DIR = path.join(__dirname, '../../../uploads/manual');
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 10 Go

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.mpg', '.mpeg', '.wmv', '.flv', '.ts', '.ogv',
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = VIDEO_EXTENSIONS.has(ext) ? ext : '.mp4';
    cb(null, `manual-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${safeExt}`);
  },
});

const fileFilter = (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (file.mimetype.startsWith('video/') || VIDEO_EXTENSIONS.has(path.extname(file.originalname).toLowerCase())) {
    cb(null, true);
    return;
  }
  cb(new Error(`Fichier non vidéo refusé: ${file.originalname}`));
};

export const mediaUpload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE, files: 200 } });

export function publicFileUrl(filename: string): string {
  const base = process.env.UPLOADS_PUBLIC_BASE_URL || 'http://localhost:4000';
  return `${base.replace(/\/+$/, '')}/uploads/manual/${filename}`;
}

export function getUploadedFilePath(filename: string): string {
  return path.join(UPLOADS_DIR, filename);
}
