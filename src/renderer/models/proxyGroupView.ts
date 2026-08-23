import type { ProxyCustomRule, ProxyGroupsInfo } from '../../shared/types';

export function haveSameProxyGroupStructure(
  previous: ProxyGroupsInfo | null,
  next: ProxyGroupsInfo
): boolean {
  if (!previous || previous.groups.length !== next.groups.length) {
    return false;
  }

  for (let groupIndex = 0; groupIndex < next.groups.length; groupIndex += 1) {
    const previousGroup = previous.groups[groupIndex];
    const nextGroup = next.groups[groupIndex];
    if (
      previousGroup.name !== nextGroup.name ||
      previousGroup.options.length !== nextGroup.options.length
    ) {
      return false;
    }

    for (let optionIndex = 0; optionIndex < nextGroup.options.length; optionIndex += 1) {
      const previousOption = previousGroup.options[optionIndex];
      const nextOption = nextGroup.options[optionIndex];
      if (
        previousOption.name !== nextOption.name ||
        previousOption.type !== nextOption.type
      ) {
        return false;
      }
    }
  }

  return true;
}

export function haveSameProxyCustomRules(
  previous: readonly ProxyCustomRule[] | null,
  next: readonly ProxyCustomRule[]
): boolean {
  if (!previous || previous.length !== next.length) {
    return false;
  }

  return previous.every((rule, index) => {
    const nextRule = next[index];
    return (
      rule.id === nextRule.id &&
      rule.type === nextRule.type &&
      rule.target === nextRule.target &&
      rule.value === nextRule.value
    );
  });
}
