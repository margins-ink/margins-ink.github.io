import type { Template } from '../../../src/lib/magazine/types';
import { duo } from './duo';
import { solo } from './solo';
import { compare } from './compare';
import { numerals } from './numerals';
import { text } from './text';
import { textCode } from './text-code';

/** Order is the u16 `template id` stored in Spreads[] (RDR2). */
export const TEMPLATE_IDS = ['duo', 'solo', 'compare', 'numerals', 'text', 'text-code'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
export const TEMPLATES: Record<TemplateId, Template> = { duo, solo, compare, numerals, text, 'text-code': textCode };
export const DISTILLED: TemplateId[] = ['duo', 'solo', 'compare', 'numerals'];
export const FULL_TEXT: TemplateId[] = ['text', 'text-code'];
export const templateId = (name: TemplateId) => TEMPLATE_IDS.indexOf(name);
export { duo, solo, compare, numerals, text, textCode };
