// Convierte el contenido de las diapositivas (slides.json) en HTML.
// Cada diapositiva elige una "distribución" (layout); ver README.md de esta carpeta.

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Texto con **negrita** y saltos de línea. */
export const t = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');

export class DeckError extends Error {}

// Tamaños disponibles para las imágenes en cada distribución (px)
const BOX = { shot: [644, 520], shotWide: [1152, 452], two: [562, 410], twoTall: [562, 330], example: [520, 470] };

export function makeRenderer({ manifest, logos = { black: 'logo-black.png', white: 'logo-white.png' } }) {
  const byId = new Map(manifest.map((m) => [m.id, m]));

  function image(spec, [maxW, maxH]) {
    if (!spec || !spec.id) throw new DeckError('Falta la imagen (image.id).');
    const m = byId.get(spec.id);
    if (!m) throw new DeckError(`Imagen inexistente en el manifiesto: "${spec.id}"`);
    // crop: zona de la imagen a mostrar, en % ({x,y,w,h}); sirve para ampliar lo importante
    const c = spec.crop || { x: 0, y: 0, w: 100, h: 100 };
    if (!(c.w > 5 && c.h > 5 && c.x >= 0 && c.y >= 0 && c.x + c.w <= 100.5 && c.y + c.h <= 100.5)) throw new DeckError(`Recorte inválido en "${spec.id}": ${JSON.stringify(c)}`);
    const srcW = (m.width * c.w) / 100;
    const srcH = (m.height * c.h) / 100;
    const k = Math.min(maxW / srcW, maxH / srcH, 1.8);
    const w = Math.round(srcW * k);
    const h = Math.round(srcH * k);
    const iw = (m.width * k).toFixed(1);
    const ih = (m.height * k).toFixed(1);
    const marks = (spec.marks || []).map((mk) => `<span class="mk" style="left:${Number(mk.x)}%;top:${Number(mk.y)}%">${esc(mk.n)}</span>`).join('');
    return `<div class="frame" style="width:${w}px;height:${h}px"><img src="${m.file}" alt="${esc(m.description)}" style="width:${iw}px;height:${ih}px;max-width:none;max-height:none;position:absolute;left:${(-(c.x / 100) * iw).toFixed(1)}px;top:${(-(c.y / 100) * ih).toFixed(1)}px">${marks}</div>`;
  }

  const callout = (c) => (c ? `<div class="callout ${esc(c.kind || 'tip')}"><span class="ci">${{ tip: '💡', warn: '⚠️', info: 'ℹ️', ok: '✅' }[c.kind || 'tip'] || '💡'}</span><div>${t(c.text)}</div></div>` : '');
  const bullets = (b) => (b?.length ? `<ul class="bul">${b.map((x) => `<li>${t(x)}</li>`).join('')}</ul>` : '');
  const steps = (s) => (s?.length ? `<ol class="steps">${s.map((x, i) => `<li><span class="n">${esc(x.n ?? i + 1)}</span><div>${t(x.text)}</div></li>`).join('')}</ol>` : '');
  const lead = (l) => (l ? `<p class="lead">${t(l)}</p>` : '');
  const title = (s) => `<h1 class="title" ${String(s.title).length > 56 ? 'style="font-size:35px"' : ''}>${t(s.title)}</h1>`;

  const frame = (s, pageNo, dark, inner, extraClass = '') => `
<section class="slide ${dark ? 'dark' : ''} ${extraClass}" data-id="${esc(s.id)}">
  ${dark ? '' : `<header class="top"><div class="kicker">${esc(s.section || '')}</div></header>`}
  ${inner}
  <footer class="foot"><img src="${dark ? logos.white : logos.black}" alt="Mr.Cook"><span>Mr.Cook POS · guía para el local</span><span class="pg">${pageNo}</span></footer>
</section>`;

  const body = (s, inner) => `<div class="content">${title(s)}${inner}</div>`;

  // ---------------- diagramas ----------------
  function diagram(d) {
    switch (d.kind) {
      case 'steps':
        return `<div class="dia"><div class="dsteps">${d.steps.map((x, i) => `<div class="dstep"><span class="num">${i + 1}</span><div class="ico">${esc(x.icon || '')}</div><h3>${t(x.title)}</h3><p>${t(x.text)}</p></div>`).join('')}</div>${d.note ? callout({ kind: 'tip', text: d.note }) : ''}</div>`;
      case 'equation': {
        const cols = d.headers.length;
        return `<div class="dia"><div class="deq" style="--cols:${cols}"><div class="hd"><div></div>${d.headers.map((h) => `<div>${t(h)}</div>`).join('')}</div>${d.rows.map((r) => `<div class="rw"><div class="nm">${t(r.label)}</div>${r.values.map((v, i) => `<div class="v ${i === r.values.length - 1 ? 'last' : ''}">${esc(v)}</div>`).join('')}</div>`).join('')}</div>${d.note ? callout({ kind: 'tip', text: d.note }) : ''}</div>`;
      }
      case 'flow':
        return `<div class="dia"><div class="dflow">${d.rows.map((r) => `<div class="drow ${esc(r.tone || '')}"><div class="lb">${t(r.label)}</div><div class="bx">${r.boxes.map((b) => `<div class="b"><div class="ico">${esc(b.icon || '')}</div><h4>${t(b.title)}</h4><p>${t(b.text || '')}</p></div>`).join('')}</div></div>`).join('')}</div></div>`;
      case 'architecture': {
        const a = d.boxes || {};
        const box = (k, def, cls = '') => `<div class="ab ${cls}"><div class="ico">${esc(a[k]?.icon ?? def.icon)}</div><h4>${t(a[k]?.title ?? def.title)}</h4><p>${t(a[k]?.text ?? def.text)}</p></div>`;
        return `<div class="dia"><div class="darch">
          ${box('screen', { icon: '🖥️', title: 'La pantalla', text: 'Lo que ves y tocás: vender, cobrar, cerrar.' })}
          <div class="ar">⇄</div>
          ${box('program', { icon: '⚙️', title: 'El programa', text: 'Hace las cuentas y aplica las reglas. Vive en la PC del local.' }, 'y')}
          <div class="ar">⇄</div>
          ${box('data', { icon: '🗄️', title: 'El archivo de datos', text: 'Donde se guarda todo: ventas, stock, personal.' }, 'd')}
          <div></div><div></div>
          <div class="av">⬇</div><div></div><div class="av">⬇</div>
          <div></div><div></div>
          ${box('reports', { icon: '📄', title: 'Excel y PDF', text: 'Cierres y resúmenes listos para imprimir.' })}
          <div></div>
          ${box('backup', { icon: '💾', title: 'Copias de seguridad', text: 'Una por día y un resumen por semana.' })}
          <div class="cloud"><div class="lb">${t(a.internetLabel || 'Solo cuando hay internet (nada de esto frena las ventas)')}</div><div class="row">
            <div class="ab"><div class="ico">${esc(a.mp?.icon ?? '💳')}</div><div><h4>${t(a.mp?.title ?? 'Mercado Pago')}</h4><p>${t(a.mp?.text ?? 'Confirma solo los cobros por QR y tarjeta.')}</p></div></div>
            <div class="ab"><div class="ico">${esc(a.drive?.icon ?? '☁️')}</div><div><h4>${t(a.drive?.title ?? 'Google Drive')}</h4><p>${t(a.drive?.text ?? 'Guarda una copia de la semana en tu cuenta.')}</p></div></div>
          </div></div></div></div>`;
      }
      case 'bars': {
        const max = Math.max(...d.items.map((i) => i.value)) || 1;
        const top = d.items.reduce((a, b) => (b.value > a.value ? b : a)).label;
        return `<div class="dia"><div class="dbars">${d.items.map((i) => `<div class="bar ${i.label === top ? 'top' : ''}"><div class="vl">${esc(i.display ?? i.value)}</div><div class="col" style="height:${Math.round((i.value / max) * 88)}%"></div></div>`).join('')}</div><div class="dlabels">${d.items.map((i) => `<div>${t(i.label)}</div>`).join('')}</div>${d.note ? callout({ kind: 'tip', text: d.note }) : ''}</div>`;
      }
      default:
        throw new DeckError(`Diagrama desconocido: "${d.kind}"`);
    }
  }

  // ---------------- distribuciones ----------------
  const layouts = {
    title: (s, p) => frame(s, p, true, `<div class="cover"><div class="l"><img class="logo" src="${logos.white}" alt="Mr.Cook"><div class="kick">${t(s.kicker || '')}</div><h1>${t(s.title)}</h1><div class="sub">${t(s.subtitle || '')}</div></div><div class="blob"></div><div class="blob-text">${t(s.badge || '')}</div></div>`),
    section: (s, p) => frame(s, p, true, `<div class="sec"><div class="big">${esc(s.number)}</div><div><h1>${t(s.title)}</h1><p>${t(s.subtitle || '')}</p></div></div>`),
    text: (s, p) => frame(s, p, false, body(s, `${lead(s.lead)}${bullets(s.bullets)}${callout(s.callout)}`)),
    shot: (s, p) => frame(s, p, false, body(s, `<div class="cols ${s.side === 'left' ? 'shot-r' : 'shot'}"><div class="txt">${lead(s.lead)}${steps(s.steps)}${bullets(s.bullets)}${callout(s.callout)}</div><div class="imgbox">${image(s.image, BOX.shot)}</div></div>`)),
    'shot-wide': (s, p) => frame(s, p, false, body(s, `${s.lead ? lead(s.lead) : ''}<div class="imgbox" style="flex:1">${image(s.image, s.lead ? [1152, 392] : BOX.shotWide)}</div>${s.caption ? `<div class="cap" style="margin-top:0">${t(s.caption)}</div>` : ''}`)),
    'two-shots': (s, p) => frame(s, p, false, body(s, `${s.lead ? lead(s.lead) : ''}<div class="two">${[s.left, s.right].map((x) => `<div><div class="imgbox">${image(x.image, s.lead || s.callout ? BOX.twoTall : BOX.two)}</div><div class="cap">${t(x.caption || '')}</div></div>`).join('')}</div>${callout(s.callout)}`)),
    example: (s, p) => {
      const tb = s.table;
      const table = tb ? `<table class="ex"><thead><tr>${tb.headers.map((h, i) => `<th class="${tb.align?.[i] === 'r' ? 'r' : ''}">${t(h)}</th>`).join('')}</tr></thead><tbody>${tb.rows.map((r) => `<tr class="${r.total ? 'tot' : ''}">${(r.cells || r).map((c, i) => `<td class="${tb.align?.[i] === 'r' ? 'r' : ''} ${String(c).startsWith('-') && tb.align?.[i] === 'r' ? 'neg' : ''}">${t(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '';
      const left = `<div class="txt">${lead(s.lead)}${s.story ? `<div class="story">${t(s.story)}</div>` : ''}${s.image ? '' : table}${s.takeaway ? `<div class="take">${t(s.takeaway)}</div>` : ''}${callout(s.callout)}</div>`;
      if (s.image) return frame(s, p, false, body(s, `<div class="cols shot"><div class="txt">${lead(s.lead)}${s.story ? `<div class="story">${t(s.story)}</div>` : ''}${table}${s.takeaway ? `<div class="take">${t(s.takeaway)}</div>` : ''}${callout(s.callout)}</div><div class="imgbox">${image(s.image, BOX.example)}</div></div>`));
      return frame(s, p, false, body(s, left));
    },
    compare: (s, p) => frame(s, p, false, body(s, `${s.lead ? lead(s.lead) : ''}<div class="cmp">${[s.left, s.right].map((c) => `<div class="${esc(c.tone || '')}"><h2>${t(c.heading)}</h2>${bullets(c.bullets)}</div>`).join('')}</div>${callout(s.callout)}`)),
    cards: (s, p) => frame(s, p, false, body(s, `${s.lead ? lead(s.lead) : ''}<div class="cards c${s.columns || (s.cards.length % 3 === 0 ? 3 : s.cards.length === 4 ? 2 : 3)}">${s.cards.map((c) => `<div class="card"><div class="ic">${esc(c.icon || '')}</div><h3>${t(c.heading)}</h3><p>${t(c.text)}</p></div>`).join('')}</div>${callout(s.callout)}`)),
    diagram: (s, p) => frame(s, p, false, body(s, `${s.lead ? lead(s.lead) : ''}${diagram(s.diagram)}${s.caption ? `<div class="cap" style="margin-top:0">${t(s.caption)}</div>` : ''}`)),
    faq: (s, p) => frame(s, p, false, body(s, `<div class="faq">${s.items.map((x) => `<div class="qa"><div class="q">${t(x.q)}</div><div class="a">${t(x.a)}</div></div>`).join('')}</div>`)),
    checklist: (s, p) => frame(s, p, false, body(s, `${s.lead ? lead(s.lead) : ''}<div class="chk">${s.items.map((x) => `<div class="ck ${x.done ? 'done' : ''}"><span class="box">${x.done ? '✓' : ''}</span><div class="tx">${t(x.text)}</div>${x.who ? `<span class="who">${esc(x.who)}</span>` : ''}</div>`).join('')}</div>`)),
    cheatsheet: (s, p) => frame(s, p, false, body(s, `${s.lead ? lead(s.lead) : ''}<div class="cheat">${s.columns.map((c) => `<div><h2>${t(c.heading)}</h2>${steps(c.steps.map((x) => ({ text: x })))}</div>`).join('')}</div>`)),
    closing: (s, p) => frame(s, p, true, `<div class="cover"><div class="l"><img class="logo" src="${logos.white}" alt="Mr.Cook"><h1 style="font-size:60px">${t(s.title)}</h1><div class="sub">${t(s.subtitle || '')}</div>${s.bullets?.length ? `<div style="max-width:780px;color:#fff">${bullets(s.bullets).replace(/<ul class="bul">/, '<ul class="bul" style="color:#fff">')}</div>` : ''}</div><div class="blob"></div></div>`),
  };

  function agenda(s, p, all) {
    const secs = all.map((x, i) => ({ x, i })).filter(({ x }) => x.layout === 'section');
    return frame(s, p, false, body(s, `${s.lead ? lead(s.lead) : ''}<div class="agenda">${secs.map(({ x, i }) => `<div class="ag"><div class="num">${esc(x.number)}</div><div><div class="t">${t(x.title)}</div><div class="s">${t(x.agenda || x.subtitle || '')}</div></div><div class="p">pág. ${i + 1}</div></div>`).join('')}</div>`));
  }

  return function render(slides) {
    return slides.map((s, i) => {
      const p = i + 1;
      try {
        if (s.layout === 'agenda') return agenda(s, p, slides);
        const fn = layouts[s.layout];
        if (!fn) throw new DeckError(`Distribución desconocida: "${s.layout}"`);
        return fn(s, p);
      } catch (e) {
        throw new DeckError(`Diapositiva ${p} (${s.id}): ${e.message}`);
      }
    }).join('\n');
  };
}
