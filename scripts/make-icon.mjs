import fs from 'node:fs';

const png = fs.readFileSync('assets/icon.png');
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // image count

const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0); // width 256
entry.writeUInt8(0, 1); // height 256
entry.writeUInt8(0, 2); // palette
entry.writeUInt8(0, 3); // reserved
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12); // offset

fs.writeFileSync('assets/icon.ico', Buffer.concat([header, entry, png]));
console.log('icon.ico written:', fs.statSync('assets/icon.ico').size, 'bytes');
