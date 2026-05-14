function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function renderTitle(title: string): string {
	const parts = title.split(/(`[^`]+`)/g);
	return parts
		.map((part) => {
			if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
				return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
			}
			return escapeHtml(part);
		})
		.join('');
}

export function plainTitle(title: string): string {
	return title.replace(/`([^`]+)`/g, '$1');
}
