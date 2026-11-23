import { z } from 'zod';

/** What the contact form of the portal sends, and nothing else; the lengths are the ones of the limits. */
export const contactForm = (limits: { nameLength: number; noteLength: number }) =>
    z.strictObject({
        supportType: z.string().trim().min(1).max(limits.nameLength).optional(),
        firstName: z.string().trim().min(1).max(limits.nameLength),
        lastName: z.string().trim().min(1).max(limits.nameLength),
        email: z.email().max(254),
        organization: z.string().trim().min(1).max(limits.nameLength),
        roleInOrganization: z.string().trim().min(1).max(limits.nameLength),
        message: z.string().trim().min(1).max(limits.noteLength),
        privacyAccepted: z.literal(true),
        marketingAccepted: z.boolean().optional()
    });

export type ContactForm = z.infer<ReturnType<typeof contactForm>>;

const escapeHtml = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The notification for the form: HTML, so everything the visitor wrote is escaped. */
export const notificationOf = (form: ContactForm): { subject: string; message: string; supportType?: string } => {
    const yesNo = (value: boolean | undefined): string => (value === true ? 'Yes' : 'No');
    const message = [
        `First name: ${escapeHtml(form.firstName)}`,
        `Last name: ${escapeHtml(form.lastName)}`,
        `Email: ${escapeHtml(form.email)}`,
        `Organization: ${escapeHtml(form.organization)}`,
        `Role in organization: ${escapeHtml(form.roleInOrganization)}`,
        `Privacy accepted: ${yesNo(form.privacyAccepted)}`,
        `Marketing accepted: ${yesNo(form.marketingAccepted)}`,
        '',
        'Message:',
        escapeHtml(form.message).replace(/\r?\n/g, '<br>')
    ].join('<br>');
    return { subject: 'New contact-us request', message, ...(form.supportType === undefined ? {} : { supportType: form.supportType }) };
};
