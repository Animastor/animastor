// Route arguments — Android passes these via Fragment arguments (Bundle); the web
// equivalent is a module-level store, because preact-router matches the full URL
// (pathname + search) and query strings would break route matching. Pages set
// these right before navigate(); the target page reads them on mount (1:1 with
// newInstance(...) + arguments Bundle).
import { signal } from '@preact/signals';

/** Connector name for /dev (DeveloperViewFragment.newInstance(connectorName)). */
export const devConnector = signal<string | null>(null);

/** editMode flag for /workflows/:name (WorkflowDetailsFragment.newInstance(..., editMode)). */
export const detailsEditMode = signal(false);
