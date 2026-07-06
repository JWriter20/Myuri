import { type Rng } from './rng.js'

export interface Vector {
  x: number
  y: number
}

export interface TimedVector extends Vector {
  timestamp: number
}

export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface ViewportSize {
  width: number
  height: number
}

export const sub = (a: Vector, b: Vector): Vector => ({ x: a.x - b.x, y: a.y - b.y })
export const add = (a: Vector, b: Vector): Vector => ({ x: a.x + b.x, y: a.y + b.y })
export const direction = (a: Vector, b: Vector): Vector => sub(b, a)
export const magnitude = (a: Vector): number => Math.hypot(a.x, a.y)

/** A point drawn uniformly from a disc of the given radius around `coordinate`. */
export const overshoot = (coordinate: Vector, radius: number, rng: Rng): Vector => {
  const angle = rng() * 2 * Math.PI
  const rad = radius * Math.sqrt(rng())
  return add(coordinate, { x: rad * Math.cos(angle), y: rad * Math.sin(angle) })
}
