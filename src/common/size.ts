const UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
const SIZE = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i;

/** A size such as `2mb` or `512kb` in bytes; undefined when it is not one. */
export const parseSize = (value: string): number | undefined => {
    const match = SIZE.exec(value.trim());
    const unit = match?.[2];
    return match === null || unit === undefined ? undefined : Math.floor(Number(match[1]) * (UNITS[unit.toLowerCase()] ?? 1));
};
