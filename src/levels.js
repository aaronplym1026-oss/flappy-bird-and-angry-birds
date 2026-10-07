// Level data. Ground pigs sit at y = 462; anything higher floats on a plank.
(function (root) {
  const LEVELS = [
    {
      name: 'Warm-up',
      birds: 3,
      pipes: [{ x: 520, gap: 280, h: 230 }],
      pigs: [{ x: 650, y: 462 }, { x: 790, y: 462 }],
    },
    {
      name: 'Twin Towers',
      birds: 4,
      pipes: [{ x: 430, gap: 250, h: 200 }, { x: 660, gap: 340, h: 190 }],
      pigs: [{ x: 570, y: 300 }, { x: 790, y: 462 }, { x: 880, y: 190 }],
    },
    {
      name: 'Pipe Dream',
      birds: 4,
      pipes: [{ x: 400, gap: 220, h: 190 }, { x: 560, gap: 340, h: 170 }, { x: 720, gap: 240, h: 170 }],
      pigs: [{ x: 500, y: 290 }, { x: 660, y: 462 }, { x: 800, y: 300 }, { x: 890, y: 462 }],
    },
    {
      name: 'Tight Squeeze',
      birds: 5,
      pipes: [
        { x: 360, gap: 300, h: 160 },
        { x: 550, gap: 210, h: 160 },
        { x: 740, gap: 320, h: 160 },
      ],
      pigs: [{ x: 485, y: 262 }, { x: 650, y: 462 }, { x: 840, y: 300 }, { x: 910, y: 462 }],
    },
  ];

  if (typeof module !== 'undefined' && module.exports) module.exports = LEVELS;
  else root.LEVELS = LEVELS;
})(typeof window !== 'undefined' ? window : globalThis);
