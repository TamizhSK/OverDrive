import type { CustomerDashboard } from './api';

// Session memory only: shown instantly on revisit, always revalidated, and cleared on sign-in/out.
let remembered: CustomerDashboard | undefined;

export const rememberDashboard = (dashboard: CustomerDashboard) => { remembered = dashboard; };
export const rememberedDashboard = () => remembered;
export const forgetDashboard = () => { remembered = undefined; };
