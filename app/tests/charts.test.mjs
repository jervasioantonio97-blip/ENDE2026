// Testes dos gráficos SVG desenhados à mão (offline-first, sem DOM).
//
// Verifica o eixo (niceMax/axisLabel), o estado vazio e que o gráfico de
// balanço nunca emite NaN nem perde a legenda, inclusive com balanço negativo.
import test from 'node:test';
import assert from 'node:assert/strict';

import { niceMax, axisLabel, balanceChart } from '../src/charts.js';

test('niceMax arredonda o topo do eixo para um máximo bonito', () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(-5), 1);
  assert.equal(niceMax(7), 10);
  assert.equal(niceMax(15), 20);
  assert.equal(niceMax(42), 50);
  assert.equal(niceMax(3000), 5000);
  assert.equal(niceMax(1_200_000), 2_000_000);
});

test('axisLabel formata valores compactos em português', () => {
  assert.equal(axisLabel(42), '42');
  assert.equal(axisLabel(850), '850');
  assert.equal(axisLabel(1200), '1 k');
  assert.equal(axisLabel(850_000), '850 k');
  assert.equal(axisLabel(1_200_000), '1,2 M');
  assert.equal(axisLabel(-500), '-500');
  assert.equal(axisLabel(-1_500_000), '-1,5 M');
});

test('balanceChart sem dados mostra estado vazio legível', () => {
  const svg = balanceChart([]);
  assert.ok(svg.includes('<svg'));
  assert.ok(svg.includes('viewBox="0 0 860 300"'));
  assert.ok(svg.includes('Sem dados no âmbito escolhido'));
  assert.ok(!svg.includes('NaN'), 'não pode conter NaN');
  assert.ok(!svg.includes('Infinity'), 'não pode conter Infinity');
});

test('balanceChart desenha barras duplas, linha de balanço e legenda', () => {
  const svg = balanceChart([
    { month: '10/2026', received: 1000, billed: 4000, balance: -3000 },
    { month: '11/2026', received: 5000, billed: 2500, balance: 2500 },
    { month: '12/2026', received: 3000, billed: 0, balance: 3000 },
  ]);

  assert.ok(svg.includes('role="img"'));
  assert.ok(svg.includes('aria-label="Balanço mensal de ganhos e perdas"'));
  assert.equal((svg.match(/<rect /g) || []).length, 6 + 2, '3 meses × 2 barras + 2 da legenda');
  assert.ok(svg.includes('url(#gGain)'), 'gradiente dos ganhos');
  assert.ok(svg.includes('url(#gLoss)'), 'gradiente das perdas');
  assert.ok(svg.includes('<polyline'), 'linha do balanço');
  assert.equal((svg.match(/<circle /g) || []).length, 3, 'um ponto por mês');
  assert.ok(svg.includes('Recebido (ganhos)'));
  assert.ok(svg.includes('Cobrado (perdas)'));
  assert.ok(svg.includes('>10/2026<'), 'rótulo do eixo X');
  assert.ok(!svg.includes('NaN'), 'não pode conter NaN');
});

test('balanceChart tolera balanço negativo e valores extremos sem NaN', () => {
  const svg = balanceChart([
    { month: '01/2026', received: 0, billed: 9_500_000, balance: -9_500_000 },
    { month: '02/2026', received: 12_345_678, billed: 1, balance: 12_345_677 },
  ]);
  assert.ok(!svg.includes('NaN'));
  assert.ok(!svg.includes('Infinity'));
  assert.ok(svg.includes('12,3 M'), 'rótulo do topo em milhões');
  assert.ok(svg.includes('-9,5 M'), 'rótulo negativo em milhões');
});

test('balanceChart aceita largura/altura próprias e um único mês', () => {
  const svg = balanceChart([{ month: '11/2026', received: 100, billed: 40, balance: 60 }], {
    width: 390,
    height: 220,
  });
  assert.ok(svg.includes('viewBox="0 0 390 220"'));
  assert.ok(!svg.includes('<polyline'), 'com um mês não há linha');
  assert.ok(!svg.includes('NaN'));

  // valores abaixo do mínimo são respeitados
  const narrow = balanceChart([], { width: 100, height: 50 });
  assert.ok(narrow.includes('viewBox="0 0 320 200"'));
});
