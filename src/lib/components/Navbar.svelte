<script lang="ts">
	import MarginsLogo from './MarginsLogo.svelte';

	const SCROLL_THRESHOLD = 10;
	const LARGE_SCROLL_THRESHOLD = 150;
	const NAVBAR_VISIBLE_ZONE = 100;

	let hidden = $state(false);
	let lastScrollY = $state(0);
	let scrollDelta = $state(0);

	const isSameDirection = (a: number, b: number) => (a > 0 && b > 0) || (a < 0 && b < 0);
	const isInVisibleZone = (scrollY: number) => scrollY <= NAVBAR_VISIBLE_ZONE;
	const isLargeScroll = (diff: number) => Math.abs(diff) > LARGE_SCROLL_THRESHOLD;
	const isScrollingDown = (delta: number) => delta > SCROLL_THRESHOLD;
	const isScrollingUp = (delta: number) => delta < -SCROLL_THRESHOLD;

	const handleScroll = () => {
		const currentScrollY = window.scrollY;
		const diff = currentScrollY - lastScrollY;
		const newDelta = isSameDirection(diff, scrollDelta) ? scrollDelta + diff : diff;

		if (isLargeScroll(diff)) {
			hidden = true;
			scrollDelta = 0;
		} else if (isInVisibleZone(currentScrollY)) {
			hidden = false;
			scrollDelta = 0;
		} else if (isScrollingDown(newDelta)) {
			hidden = true;
			scrollDelta = newDelta;
		} else if (isScrollingUp(newDelta)) {
			hidden = false;
			scrollDelta = newDelta;
		} else {
			scrollDelta = newDelta;
		}

		lastScrollY = currentScrollY;
	};

	$effect(() => {
		window.addEventListener('scroll', handleScroll, { passive: true });
		return () => window.removeEventListener('scroll', handleScroll);
	});
</script>

<nav class="navbar" class:hidden>
	<div class="navbar-inner">
		<a href="/" class="nav-link" aria-label="Home">
			<MarginsLogo size={20} />
		</a>
	</div>
</nav>

<style>
	.navbar {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		z-index: 1000;
		padding: 0 1.5rem;
		background: var(--background);
		transform: translateY(0);
		transition: transform 0.25s ease;
	}

	.navbar.hidden {
		transform: translateY(-100%);
	}

	.navbar-inner {
		max-width: 640px;
		margin: 0 auto;
		padding: 1rem 0;
		border-bottom: 1px solid var(--border);
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.nav-link {
		color: var(--text-primary);
		text-decoration: none;
		font-size: 0.8125rem;
		font-weight: 500;
		letter-spacing: -0.01em;
		transition: color 0.15s ease;
	}

	.nav-link:hover {
		color: var(--text-tertiary);
	}

	@media (max-width: 640px) {
		.navbar {
			padding: 0 1.25rem;
		}

		.navbar-inner {
			padding: 0.875rem 0;
		}

		.nav-link {
			font-size: 0.8125rem;
		}
	}
</style>
