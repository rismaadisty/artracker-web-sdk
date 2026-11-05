import { BreadcrumbBuffer } from '../breadcrumbs'

test('ring buffer membuang entri terlama di atas limit', () => {
  const b = new BreadcrumbBuffer(3)
  for (let i = 1; i <= 5; i++) b.add({ type: 't', at: i, data: { i } })
  expect(b.snapshot().map((x) => x.at)).toEqual([3, 4, 5])
})

test('snapshot mengembalikan salinan', () => {
  const b = new BreadcrumbBuffer(3)
  b.add({ type: 't', at: 1, data: {} })
  b.snapshot().pop()
  expect(b.snapshot()).toHaveLength(1)
})
