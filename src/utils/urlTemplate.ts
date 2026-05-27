export function expandUrlTemplate(template: string, tag: string) {
	if (!template) return template;
	return template.replace(/\{\s*tag\s*\}/gi, encodeURIComponent(tag));
}
