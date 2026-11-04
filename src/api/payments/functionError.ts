/**
 * supabase.functions.invoke turns a non-2xx response into a generic error, with the response
 * itself in error.context. This reads what the function said.
 */
export const readFunctionError = async (error: unknown): Promise<{ message?: string; error_code?: string }> => {
  const context = (error as { context?: Response }).context;
  if (!context || typeof context.json !== 'function') return {};
  try {
    return await context.clone().json();
  } catch {
    return {};
  }
};
