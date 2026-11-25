import { describe, expect, it } from 'vitest';
import { fileTargetsIn, filePathsIn } from './file-policy';

const ID = '3f2b8c6e-1a4d-4e7b-9c3a-5d6e7f8a9b0c';

const productWith = (...values: unknown[]) => ({
    productSpecCharacteristic: [
        { name: 'policy', valueType: 'authorizationPolicy', productSpecCharacteristicValue: values },
        { name: 'other', valueType: 'string', productSpecCharacteristicValue: [{ value: `/private/${ID}` }] }
    ]
});

describe('the files that an access policy names', () => {
    it('reads the paths under the files prefix from the policy only, wherever they are in it', () => {
        const spec = productWith({ value: { rules: [`GET /private/${ID}`] } }, '/public/x');
        expect(filePathsIn(spec)).toEqual([`GET /private/${ID}`]);
        expect(filePathsIn({})).toEqual([]);
        expect(filePathsIn(null)).toEqual([]);
    });

    it('names a file by its id, whatever follows it, in lower case', () => {
        expect(fileTargetsIn(productWith(`/private/${ID.toUpperCase()}/content`, `^/private/${ID}$`)).ids).toEqual([
            ID,
            ID
        ]);
    });

    it('calls wide what could match files without naming one: no id, a pattern or only the start of an id', () => {
        const wide = ['/private/', '/private/.*', '/private/3f2b8c6e-1a4d', `/private/${ID.slice(0, 8)}*`];
        expect(fileTargetsIn(productWith(...wide)).wide).toEqual(wide);
    });

    it('does not take for a file what cannot be one of the file service', () => {
        expect(fileTargetsIn(productWith('/private/readme.txt', '/other/prefix'))).toEqual({ ids: [], wide: [] });
    });

    it('finds each path of a string that names several', () => {
        const other = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
        expect(fileTargetsIn(productWith(`/private/${ID}|/private/${other}`)).ids).toEqual([ID, other]);
    });
});
