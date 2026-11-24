import { describe, expect, it } from 'vitest';
import { normalizeCountry } from './countries';

describe('normalizeCountry', () => {
    it('gives the code of a country of the European Union, whatever the case', () => {
        expect(normalizeCountry('Spain')).toBe('ES');
        expect(normalizeCountry('CZECH REPUBLIC')).toBe('CZ');
    });

    it('leaves what it does not know as it came, names of Object included', () => {
        expect(normalizeCountry('ES')).toBe('ES');
        expect(normalizeCountry('Narnia')).toBe('Narnia');
        expect(normalizeCountry('constructor')).toBe('constructor');
    });
});
