import { rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function getDirSize(dir) {
  let size = 0;
  if (!existsSync(dir)) return 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          size += await getDirSize(fullPath);
        } else {
          const s = await stat(fullPath);
          size += s.size;
        }
      } catch {}
    }
  } catch {}
  return size;
}

function formatMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

console.log('=== DỌN DẸP VÀ TỐI ƯU HÓA DUNG LƯỢNG HỆ THỐNG ===\n');

let totalFreed = 0;

// 1. Dọn dẹp thư mục build & cache tạm thời
const tempDirs = [
  'dist',
  '.electron-cache',
  '.desktop-test',
  '.desktop-build',
  '.npm-cache',
];

console.log('[1/3] Dọn dẹp file build và cache tạm...');
for (const rel of tempDirs) {
  const full = path.join(root, rel);
  if (existsSync(full)) {
    const size = await getDirSize(full);
    try {
      await rm(full, { recursive: true, force: true });
      totalFreed += size;
      console.log(`  ✓ Đã xóa ${rel.padEnd(20)}: giải phóng ${formatMB(size)}`);
    } catch (err) {
      console.warn(`  ! Không thể xóa ${rel}: ${err.message}`);
    }
  } else {
    console.log(`  - ${rel.padEnd(20)}: không tồn tại (đã sạch)`);
  }
}

// 2. Dọn dẹp browser cache trong data/profiles (bảo toàn cookies & session)
console.log('\n[2/3] Dọn dẹp cache trình duyệt (giữ nguyên đăng nhập Facebook & cookies)...');
const profilesDir = path.join(root, 'data', 'profiles');
const CACHE_DIR_NAMES = new Set([
  'Cache',
  'Code Cache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'blob_storage',
  'AutofillAiModelCache',
  'Crashpad',
]);

if (existsSync(profilesDir)) {
  const profileEntries = await readdir(profilesDir, { withFileTypes: true });
  for (const prof of profileEntries) {
    if (!prof.isDirectory()) continue;
    const profPath = path.join(profilesDir, prof.name);
    
    // Scan recursively for cache directories to remove
    async function cleanCacheSubdirs(dir) {
      try {
        const subEntries = await readdir(dir, { withFileTypes: true });
        for (const sub of subEntries) {
          if (!sub.isDirectory()) continue;
          const subPath = path.join(dir, sub.name);
          if (CACHE_DIR_NAMES.has(sub.name)) {
            const size = await getDirSize(subPath);
            await rm(subPath, { recursive: true, force: true });
            totalFreed += size;
            console.log(`  ✓ Đã xóa cache: ${path.relative(root, subPath)} (${formatMB(size)})`);
          } else {
            await cleanCacheSubdirs(subPath);
          }
        }
      } catch {}
    }

    await cleanCacheSubdirs(profPath);
  }
} else {
  console.log('  - Không có thư mục data/profiles.');
}

// 3. Tối ưu hóa SQLite database (VACUUM & TRUNCATE WAL)
console.log('\n[3/3] Tối ưu hóa cơ sở dữ liệu SQLite...');
const dbPath = path.join(root, 'data', 'monitor.sqlite');
if (existsSync(dbPath)) {
  const sizeBefore = (await stat(dbPath)).size;
  try {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
    db.close();
    const sizeAfter = (await stat(dbPath)).size;
    const dbFreed = Math.max(0, sizeBefore - sizeAfter);
    totalFreed += dbFreed;
    console.log(`  ✓ Đã nén monitor.sqlite: ${formatMB(sizeBefore)} -> ${formatMB(sizeAfter)} (giải phóng ${formatMB(dbFreed)})`);
  } catch (err) {
    console.warn(`  ! Không thể nén database: ${err.message}`);
  }
} else {
  console.log('  - Chưa có database data/monitor.sqlite.');
}

console.log('\n================================================');
console.log(`TỔNG DUNG LƯỢNG ĐÃ GIẢI PHÓNG: ${formatMB(totalFreed)}`);
console.log('Tất cả phiên đăng nhập Facebook và dữ liệu nhóm đều được giữ nguyên 100%.');
console.log('================================================\n');
