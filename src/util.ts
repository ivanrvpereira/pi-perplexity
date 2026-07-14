/** Safely extract a message from an unknown caught value. */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return "Unknown error";
}
