import { createZip } from './zip.js';

/**
 * Презентация PPTX без внешних библиотек (бэклог CW2.3, ADR 0066).
 *
 * slides: [{ title, bullets?: [string | { text, level }], subtitle?, notes? }]
 * Первый слайд без пунктов — титульный (заголовок крупно и подзаголовок).
 * Формат 16:9, одна тема, один макет; пункты — до 4 уровней.
 */
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const W = 12192000;
const H = 6858000;

const esc = (text) =>
  String(text ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function run(text, { size, bold = false, color = '1F2937' } = {}) {
  return `<a:r><a:rPr lang="ru-RU" sz="${size}"${bold ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${esc(text)}</a:t></a:r>`;
}

function shape(id, name, { x, y, cx, cy }, paragraphs, anchor = 't') {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="91440" rIns="91440" tIns="45720" bIns="45720" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

function bulletParagraph(item) {
  const text = typeof item === 'string' ? item : item?.text;
  const level = Math.min(Math.max(Number(typeof item === 'object' ? item.level : 0) || 0, 0), 3);
  const size = [2400, 2000, 1800, 1600][level];
  const indent = 342900 + level * 457200;
  return `<a:p><a:pPr marL="${indent}" indent="-285750"><a:buFont typeface="Arial"/><a:buChar char="${level ? '–' : '•'}"/></a:pPr>${run(text, { size, color: level ? '374151' : '1F2937' })}</a:p>`;
}

function slideXml(slide, index) {
  const bullets = Array.isArray(slide?.bullets) ? slide.bullets.filter((b) => (typeof b === 'string' ? b : b?.text)) : [];
  const titleSlide = index === 0 && !bullets.length;
  let body;
  if (titleSlide) {
    body =
      shape(2, 'Заголовок', { x: 685800, y: 2130425, cx: W - 1371600, cy: 1470025 }, `<a:p><a:pPr algn="ctr"/>${run(slide.title, { size: 4400, bold: true })}</a:p>`, 'b') +
      (slide.subtitle ? shape(3, 'Подзаголовок', { x: 1371600, y: 3886200, cx: W - 2743200, cy: 1752600 }, `<a:p><a:pPr algn="ctr"/>${run(slide.subtitle, { size: 2400, color: '4B5563' })}</a:p>`) : '');
  } else {
    body =
      shape(2, 'Заголовок', { x: 609600, y: 304800, cx: W - 1219200, cy: 1143000 }, `<a:p>${run(slide.title, { size: 3600, bold: true })}</a:p>`, 'ctr') +
      // Акцентная полоса под заголовком.
      `<p:sp><p:nvSpPr><p:cNvPr id="5" name="Полоса"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="1447800"/><a:ext cx="1219200" cy="54864"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="4F46E5"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>` +
      (bullets.length ? shape(3, 'Текст', { x: 609600, y: 1600200, cx: W - 1219200, cy: H - 2133600 }, bullets.map(bulletParagraph).join('')) : '') +
      (slide.subtitle ? shape(4, 'Подпись', { x: 609600, y: H - 609600, cx: W - 1219200, cy: 457200 }, `<a:p>${run(slide.subtitle, { size: 1400, color: '6B7280' })}</a:p>`) : '');
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

const SLIDE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`;

const LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Пустой"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const LAYOUT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;

const MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`;

const MASTER_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`;

const clr = (name, val) => `<a:${name}><a:srgbClr val="${val}"/></a:${name}>`;
const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="MAI"><a:themeElements><a:clrScheme name="MAI">${clr('dk1', '000000')}${clr('lt1', 'FFFFFF')}${clr('dk2', '1F2937')}${clr('lt2', 'F3F4F6')}${clr('accent1', '4F46E5')}${clr('accent2', '0EA5E9')}${clr('accent3', '10B981')}${clr('accent4', 'F59E0B')}${clr('accent5', 'EF4444')}${clr('accent6', '8B5CF6')}${clr('hlink', '2563EB')}${clr('folHlink', '7C3AED')}</a:clrScheme><a:fontScheme name="MAI"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="MAI"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

/** PPTX из списка слайдов. */
export function slidesToPptx(slides, { title = '' } = {}) {
  const list = (Array.isArray(slides) && slides.length ? slides : [{ title: title || 'Презентация' }]).slice(0, 200);
  const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${list.map((_s, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const presRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>${list.map((_s, i) => `<Relationship Id="rId${i + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${list.map((_s, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`;
  const entries = [
    { name: '[Content_Types].xml', data: types },
    { name: '_rels/.rels', data: rootRels },
    { name: 'ppt/presentation.xml', data: presentation },
    { name: 'ppt/_rels/presentation.xml.rels', data: presRels },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: MASTER },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: MASTER_RELS },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: LAYOUT },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: LAYOUT_RELS },
    { name: 'ppt/theme/theme1.xml', data: THEME, compress: true },
  ];
  list.forEach((slide, i) => {
    entries.push({ name: `ppt/slides/slide${i + 1}.xml`, data: slideXml(slide, i), compress: true });
    entries.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: SLIDE_RELS });
  });
  return createZip(entries);
}

/** Слайды из Markdown: «# » или «## » — новый слайд, «- » — пункты (отступ — уровень). */
export function markdownToSlides(markdown) {
  const slides = [];
  let current = null;
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const heading = /^#{1,2}\s+(.+)/.exec(line);
    if (heading) {
      current = { title: heading[1].trim(), bullets: [] };
      slides.push(current);
      continue;
    }
    const bullet = /^(\s*)[-*]\s+(.+)/.exec(line);
    if (bullet && current) {
      current.bullets.push({ text: bullet[2].trim(), level: Math.min(Math.floor(bullet[1].replace(/\t/g, '  ').length / 2), 3) });
      continue;
    }
    if (line.trim() && current) {
      if (!current.bullets.length && !current.subtitle) current.subtitle = line.trim();
      else current.bullets.push(line.trim());
    }
  }
  return slides;
}
