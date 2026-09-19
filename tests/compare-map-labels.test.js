import test from "node:test";
import assert from "node:assert/strict";
import { layoutCompareMapLabels } from "../src/utils/compareMapLabels.js";

const collides = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

test("nearby F and GM labels separate without changing plotted financial coordinates", () => {
  const points = [{ ticker: "F", x: 640, y: 91 }, { ticker: "GM", x: 646, y: 95 }];
  const original = structuredClone(points);
  const labels = layoutCompareMapLabels(points, { x: 86, y: 35, width: 900, height: 360 });
  assert.equal(labels.length, 2);
  assert.equal(collides(labels[0], labels[1]), false);
  for (const label of labels) {
    const point = points.find((entry) => entry.ticker === label.ticker);
    assert.deepEqual([label.pointX, label.pointY], [point.x, point.y]);
  }
  assert.deepEqual(points, original);
});

test("mobile labels stay within the plot width and remain distinct at matching coordinates", () => {
  const points = ["BRK.B", "MSFT", "NVDA", "AAPL"].map((ticker) => ({ ticker, x: 270, y: 40 }));
  const plot = { x: 86, y: 35, width: 210, height: 260 };
  const labels = layoutCompareMapLabels(points, plot);
  for (const [index, label] of labels.entries()) {
    assert.ok(label.left >= plot.x && label.right <= plot.x + plot.width);
    for (const other of labels.slice(index + 1)) assert.equal(collides(label, other), false);
  }
  assert.deepEqual(layoutCompareMapLabels([...points].reverse(), plot), labels);
});

test("isolated labels stay near their point and incomplete chart coordinates are omitted", () => {
  const labels = layoutCompareMapLabels([
    { ticker: "TSLA", x: 150, y: 200 }, { ticker: "F", x: undefined, y: 10 },
  ], { x: 86, y: 35, width: 900, height: 360 });
  assert.equal(labels.length, 1);
  assert.equal(labels[0].x, 150);
  assert.equal(labels[0].y, 180);
});
