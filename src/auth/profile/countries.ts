const CODES: Record<string, string> = {
    austria: 'AT',
    belgium: 'BE',
    bulgaria: 'BG',
    croatia: 'HR',
    cyprus: 'CY',
    'czech republic': 'CZ',
    denmark: 'DK',
    estonia: 'EE',
    finland: 'FI',
    france: 'FR',
    germany: 'DE',
    greece: 'GR',
    hungary: 'HU',
    ireland: 'IE',
    italy: 'IT',
    latvia: 'LV',
    lithuania: 'LT',
    luxembourg: 'LU',
    malta: 'MT',
    netherlands: 'NL',
    poland: 'PL',
    portugal: 'PT',
    romania: 'RO',
    slovakia: 'SK',
    slovenia: 'SI',
    spain: 'ES',
    sweden: 'SE'
};

/** The ISO code of a country of the European Union given by name; anything else goes as it came. */
export const normalizeCountry = (country: string): string => {
    const name = country.toLowerCase();
    return Object.hasOwn(CODES, name) ? (CODES[name] as string) : country;
};
