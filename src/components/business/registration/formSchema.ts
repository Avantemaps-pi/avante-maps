
import * as z from "zod";

export const businessTypes = [
  "Restaurant/Cafe",
  "Retail Store",
  "Service Provider",
  "Entertainment Venue",
  "Health & Wellness",
  "Education",
  "Professional Services",
  "Accommodation",
  "Transportation",
  "Technology",
  "Arts & Crafts",
  "Construction",
  "Agriculture",
  "Manufacturing",
  "Wholesale",
  "Other"
];

export const daysOfWeek = [
  { name: "Monday", short: "Mon", open: "mondayOpen", close: "mondayClose", closed: "mondayClosed" },
  { name: "Tuesday", short: "Tue", open: "tuesdayOpen", close: "tuesdayClose", closed: "tuesdayClosed" },
  { name: "Wednesday", short: "Wed", open: "wednesdayOpen", close: "wednesdayClose", closed: "wednesdayClosed" },
  { name: "Thursday", short: "Thu", open: "thursdayOpen", close: "thursdayClose", closed: "thursdayClosed" },
  { name: "Friday", short: "Fri", open: "fridayOpen", close: "fridayClose", closed: "fridayClosed" },
  { name: "Saturday", short: "Sat", open: "saturdayOpen", close: "saturdayClose", closed: "saturdayClosed" },
  { name: "Sunday", short: "Sun", open: "sundayOpen", close: "sundayClose", closed: "sundayClosed" }
];

// XSS Protection: Patterns that could be used for script injection
const dangerousPatterns = [
  /<script[^>]*>.*?<\/script>/gi,
  /on\w+\s*=/gi,
  /javascript:/gi,
  /<iframe/gi,
  /<object/gi,
  /<embed/gi,
];

const sanitizeInput = (value: string, fieldName: string) => {
  if (dangerousPatterns.some((pattern) => pattern.test(value))) {
    throw new Error(`${fieldName} contains invalid characters`);
  }
  return value;
};

export const formSchema = z.object({
  // firstName and lastName are now optional - we use the Pi username instead
  // Kept for backwards compatibility with existing data
  firstName: z.string().optional().default(''),
  lastName: z.string().optional().default(''),
  businessName: z.string().min(1, { message: "Business name is required" }).transform((val, ctx) => {
    try {
      return sanitizeInput(val, "Business name");
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
      return z.NEVER;
    }
  }),
  countryCode: z.string().default('+1'),
  phone: z.string().min(1, { message: "Phone number is required" }).min(4, { message: "Phone number is too short" }).max(15, { message: "Phone number is too long" }),
  email: z.string().email({ message: "Invalid email address" }),
  // Update business only: email the owner when a customer messages the business
  notifyNewMessageEmail: z.boolean().optional().default(true),
  website: z.string().optional().refine((val) => {
    if (!val) return true;
    // Must start with https://
    if (!val.startsWith('https://')) return false;
    // Must contain .pinet
    if (!val.includes('.pinet')) return false;
    // Must be a valid URL structure
    try {
      new URL(val);
      return true;
    } catch {
      return false;
    }
  }, {
    message: "Website URL must start with https:// and contain a .pinet subdomain (e.g., https://example.pinet.com/)"
  }),
  streetAddress: z.string().min(1, { message: "Street address is required" }).transform((val, ctx) => {
    try {
      return sanitizeInput(val, "Street address");
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
      return z.NEVER;
    }
  }),
  apartment: z.string().optional().transform((val, ctx) => {
    if (!val) return val;
    try {
      return sanitizeInput(val, "Apartment");
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
      return z.NEVER;
    }
  }),
  city: z.string().min(1, { message: "City is required" }).transform((val, ctx) => {
    try {
      return sanitizeInput(val, "City");
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
      return z.NEVER;
    }
  }),
  state: z.string().min(1, { message: "State is required" }).transform((val, ctx) => {
    try {
      return sanitizeInput(val, "State");
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
      return z.NEVER;
    }
  }),
  zipCode: z.string().min(1, { message: "ZIP code is required" }),
  country: z.string().min(1, { message: "Country is required" }).transform((val, ctx) => {
    try {
      return sanitizeInput(val, "Country");
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
      return z.NEVER;
    }
  }),
  businessTypes: z.array(z.string()).min(1, { message: "Choose at least one business type" }),
  businessDescription: z.string().min(10, { message: "Description must be at least 10 characters" }).transform((val, ctx) => {
    try {
      return sanitizeInput(val, "Business description");
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
      return z.NEVER;
    }
  }),
  piWalletAddress: z.string().min(1, { message: "Pi wallet address is required" }),
  mondayOpen: z.string(),
  mondayClose: z.string(),
  mondayClosed: z.boolean(),
  tuesdayOpen: z.string(),
  tuesdayClose: z.string(),
  tuesdayClosed: z.boolean(),
  wednesdayOpen: z.string(),
  wednesdayClose: z.string(),
  wednesdayClosed: z.boolean(),
  thursdayOpen: z.string(),
  thursdayClose: z.string(),
  thursdayClosed: z.boolean(),
  fridayOpen: z.string(),
  fridayClose: z.string(),
  fridayClosed: z.boolean(),
  saturdayOpen: z.string(),
  saturdayClose: z.string(),
  saturdayClosed: z.boolean(),
  sundayOpen: z.string(),
  sundayClose: z.string(),
  sundayClosed: z.boolean(),
});

export type FormValues = z.infer<typeof formSchema>;
