(function installBoardPreview(global) {
  'use strict';

  // The editor's current board format is a 64 by 44 grid.
  const width = 64;
  const height = 44;
  const cellCount = width * height;
  const hex = '0123456789abcdef';
  const palette = [
    null, '#293039', '#313a44', '#3a4653',
    '#576472', '#627080', '#6e7d8c', '#7d8a99',
    '#8b98a8', '#9ba8b6', '#adb8c5', '#bec8d4',
    '#cfd8e2', '#dfe6ee', '#edf2f7', '#fafcff',
  ];

  function luminance(color) {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return 128;
    const rgb = Number.parseInt(color.slice(1), 16);
    return (rgb >> 16) * .2126 + ((rgb >> 8) & 255) * .7152 + (rgb & 255) * .0722;
  }

  function fromWorld(world, zoneCellsFor = (_world, zone) => zone.cells) {
    const cells = new Uint8Array(cellCount);
    let end = 0;
    for (const zone of world?.zones ?? []) {
      if (!zone.enabled) continue;
      const shade = 1 + Math.round(luminance(zone.color) / 128);
      for (const cell of zoneCellsFor(world, zone) ?? []) {
        if (!Number.isInteger(cell) || cell < 0 || cell >= cellCount) continue;
        cells[cell] = Math.max(cells[cell], shade);
        end = Math.max(end, cell + 1);
      }
    }

    const tools = new Map((world?.tools ?? []).map(tool => [
      tool.id,
      tool.mobile ? 15 : 4 + Math.round(luminance(tool.color) * 10 / 255),
    ]));
    for (const entity of world?.entities ?? []) {
      const { x, y } = entity;
      const shade = tools.get(entity.toolId);
      if (entity.removed || !shade || !Number.isInteger(x) || !Number.isInteger(y) ||
          x < 0 || x >= width || y < 0 || y >= height) continue;
      const cell = y * width + x;
      cells[cell] = shade;
      end = Math.max(end, cell + 1);
    }

    // One character per cell, with the unused zero tail left implicit.
    let preview = '';
    for (let i = 0; i < end; i++) preview += hex[cells[i]];
    return preview;
  }

  function update(canvas, source) {
    const ctx = canvas?.getContext?.('2d');
    if (!ctx || !canvas.width || !canvas.height) return;
    const preview = typeof source === 'string' ? source : fromWorld(source);
    const scale = Math.min(canvas.width / (width + 2), canvas.height / (height + 2));
    const x0 = (canvas.width - width * scale) / 2;
    const y0 = (canvas.height - height * scale) / 2;
    ctx.fillStyle = '#171b20';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#21272e';
    ctx.fillRect(x0, y0, width * scale, height * scale);

    for (let i = 0; i < Math.min(preview.length, cellCount); i++) {
      const color = palette[hex.indexOf(preview[i])];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x0 + (i % width) * scale, y0 + Math.floor(i / width) * scale, scale, scale);
    }

    ctx.lineWidth = Math.min(1, scale / 4);
    ctx.strokeStyle = '#161a215c';
    ctx.beginPath();
    for (let x = 0; x <= width; x++) {
      ctx.moveTo(x0 + x * scale, y0);
      ctx.lineTo(x0 + x * scale, y0 + height * scale);
    }
    for (let y = 0; y <= height; y++) {
      ctx.moveTo(x0, y0 + y * scale);
      ctx.lineTo(x0 + width * scale, y0 + y * scale);
    }
    ctx.stroke();
    ctx.strokeStyle = '#738191';
    ctx.strokeRect(x0, y0, width * scale, height * scale);
  }

  global.PrototeerBoardPreview = { fromWorld, update };
})(globalThis);
