import { formatBytes, formatDuration } from '../src/format'

describe('formatBytes', () => {
  it('scales to binary units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.00 KiB')
    expect(formatBytes(33 * 1024 * 1024)).toBe('33.00 MiB')
    expect(formatBytes(1073741824)).toBe('1.00 GiB')
  })
})

describe('formatDuration', () => {
  it('reads naturally at every scale a run produces', () => {
    expect(formatDuration(412)).toBe('412ms')
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(45_000)).toBe('45.0s')
    expect(formatDuration(4 * 60_000)).toBe('4m 0s')
    expect(formatDuration(255_000)).toBe('4m 15s')
  })
})
