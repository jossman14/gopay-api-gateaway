function calculateCRC16(payload) {
    let crc = 0xFFFF;
    for (let i = 0; i < payload.length; i++) {
        crc ^= payload.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x8000) !== 0
                ? ((crc << 1) ^ 0x1021) & 0xFFFF
                : (crc << 1) & 0xFFFF;
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

function parseTLV(payload) {
    const tags = [];
    let offset = 0;

    while (offset < payload.length) {
        if (offset + 4 > payload.length) throw new Error('Payload TLV terpotong');
        const tag = payload.slice(offset, offset + 2);
        const lengthText = payload.slice(offset + 2, offset + 4);
        if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lengthText)) {
            throw new Error(`Tag TLV tidak valid pada posisi ${offset}`);
        }
        const length = Number(lengthText);
        const valueStart = offset + 4;
        const valueEnd = valueStart + length;
        if (valueEnd > payload.length) throw new Error(`Nilai tag ${tag} terpotong`);
        tags.push({ tag, val: payload.slice(valueStart, valueEnd) });
        offset = valueEnd;
    }

    return tags;
}

function encodeTLV(tags) {
    return tags.map(({ tag, val }) => {
        if (val.length > 99) throw new Error(`Nilai tag ${tag} melebihi 99 karakter`);
        return `${tag}${String(val.length).padStart(2, '0')}${val}`;
    }).join('');
}

function upsertReference(tags, reference) {
    if (!reference) return tags;
    if (!/^[A-Za-z0-9._-]{1,25}$/.test(reference)) {
        throw new Error('Reference QRIS harus 1-25 karakter ASCII: huruf, angka, titik, garis bawah, atau minus');
    }

    const result = [...tags];
    const index = result.findIndex(item => item.tag === '62');
    const nested = index === -1 ? [] : parseTLV(result[index].val);
    const referenceIndex = nested.findIndex(item => item.tag === '05');

    if (referenceIndex === -1) nested.push({ tag: '05', val: reference });
    else nested[referenceIndex] = { tag: '05', val: reference };

    const additionalData = { tag: '62', val: encodeTLV(nested) };
    if (index === -1) {
        const crcIndex = result.findIndex(item => item.tag === '63');
        result.splice(crcIndex === -1 ? result.length : crcIndex, 0, additionalData);
    } else {
        result[index] = additionalData;
    }
    return result;
}

function generateDynamicQRIS(staticTemplate, amount, reference = null) {
    if (!staticTemplate) throw new Error('QRIS static belum dikonfigurasi');
    const numericAmount = Number(amount);
    if (!Number.isSafeInteger(numericAmount) || numericAmount <= 0) {
        throw new Error('Nominal QRIS harus berupa bilangan bulat positif');
    }

    let payload = staticTemplate.trim();
    const crcPosition = payload.lastIndexOf('6304');
    if (crcPosition !== -1 && crcPosition === payload.length - 8) {
        payload = payload.slice(0, crcPosition);
    }

    let tags = parseTLV(payload).filter(item => item.tag !== '63');
    const amountText = String(numericAmount);
    let hasMethod = false;
    let hasAmount = false;
    const next = [];

    for (const item of tags) {
        if (item.tag === '01') {
            next.push({ tag: '01', val: '12' });
            hasMethod = true;
        } else if (item.tag === '54') {
            next.push({ tag: '54', val: amountText });
            hasAmount = true;
        } else if (item.tag === '58' && !hasAmount) {
            next.push({ tag: '54', val: amountText }, item);
            hasAmount = true;
        } else {
            next.push(item);
        }
    }

    if (!hasMethod) next.splice(1, 0, { tag: '01', val: '12' });
    if (!hasAmount) next.push({ tag: '54', val: amountText });
    tags = upsertReference(next, reference);

    const withoutCRC = encodeTLV(tags) + '6304';
    return withoutCRC + calculateCRC16(withoutCRC);
}

module.exports = { calculateCRC16, parseTLV, generateDynamicQRIS };
