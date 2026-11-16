/**
 * Keyboard layout model for neighbor-key typo lookups.
 * Ported from HumanTyping (https://github.com/Lax3n/HumanTyping)
 */

import type { Rng } from '../rng.js'

export class KeyboardLayout {
  private grid: string[][]
  private posMap: Map<string, [number, number]>
  private directAccents: Set<string>
  private composedAccents: Set<string>

  constructor() {
    this.grid = [
      [...'`1234567890-='],
      [...'qwertyuiop[]\\'],
      [..."asdfghjkl;'"],
      [...'zxcvbnm,./']
    ]
    this.posMap = this.buildPosMap()
    this.directAccents = new Set()
    this.composedAccents = new Set('âêîôûäëïöüéèàùç'.split(''))
  }

  private buildPosMap(): Map<string, [number, number]> {
    const mapping = new Map<string, [number, number]>()
    for (let r = 0; r < this.grid.length; r++) {
      for (let c = 0; c < this.grid[r].length; c++) {
        mapping.set(this.grid[r][c], [r, c])
      }
    }
    return mapping
  }

  private normalizeChar(char: string): string {
    char = char.toLowerCase()
    if (this.composedAccents.has(char)) {
      return char.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    }
    return char
  }

  hasKey(char: string): boolean {
    return this.posMap.has(this.normalizeChar(char))
  }

  getNeighborKeys(char: string): string[] {
    const normalized = this.normalizeChar(char)
    const pos = this.posMap.get(normalized)
    if (!pos) return []

    const [r, c] = pos
    const neighbors: string[] = []
    const deltas = [
      [-1, -1], [-1, 0], [-1, 1],
      [0, -1],           [0, 1],
      [1, -1],  [1, 0],  [1, 1]
    ]

    for (const [dr, dc] of deltas) {
      const nr = r + dr
      const nc = c + dc
      if (nr >= 0 && nr < this.grid.length && nc >= 0 && nc < this.grid[nr].length) {
        neighbors.push(this.grid[nr][nc])
      }
    }

    return neighbors
  }

  getRandomNeighbor(char: string, rng: Rng): string {
    const wasUpper = char === char.toUpperCase() && char !== char.toLowerCase()
    const neighbors = this.getNeighborKeys(char)

    let result: string
    if (neighbors.length === 0) {
      const flat = this.grid.flat()
      result = flat[Math.floor(rng() * flat.length)]
    } else {
      result = neighbors[Math.floor(rng() * neighbors.length)]
    }

    return wasUpper ? result.toUpperCase() : result
  }

  isDirectAccent(char: string): boolean {
    return this.directAccents.has(char.toLowerCase())
  }

  isComposedAccent(char: string): boolean {
    return this.composedAccents.has(char.toLowerCase())
  }
}
