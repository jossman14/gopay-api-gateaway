function rawProviderAmount(transaction) {
    return Number.parseInt(
        transaction?.gross_amount
        || transaction?.real_gross_amount
        || transaction?.amount?.value
        || transaction?.amount
        || 0,
        10
    );
}

function providerAmountCandidates(transaction) {
    const raw = rawProviderAmount(transaction);
    if (!Number.isSafeInteger(raw) || raw <= 0) return [];

    const candidates = [raw];
    const currency = String(transaction?.currency || 'IDR').toUpperCase();
    if (currency === 'IDR' && raw % 100 === 0) candidates.push(raw / 100);
    return candidates;
}

module.exports = { rawProviderAmount, providerAmountCandidates };
