import type { Role } from './types';

export const palette = {
  bg: '#070B14',
  grid: '#1A2438',
  line: '#2E3D5C',
  fill: '#0B1120',
};

export const roleColor: Record<Role, string> = {
  client: '#4FD1FF',
  edge: '#A084FF',
  service: '#6E9BFF',
  data: '#5EF0B5',
  async: '#FFB547',
};

export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
