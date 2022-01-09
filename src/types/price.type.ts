import { Pair } from './pair.type';

export type Price = {
  pair: Pair;
  token1: number;
  token2: number;
  updated_on_block: number;
};
