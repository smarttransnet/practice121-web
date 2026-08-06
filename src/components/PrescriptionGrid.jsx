/**
 * PrescriptionGrid.jsx
 *
 * Formatted & Directly Editable Prescription Component.
 * Supports:
 *   1. Sentence View Mode (Default end-user read-only presentation)
 *   2. Grid Edit Mode with ComboBox search, custom typing, auto-fill from Favourites, and row editing.
 */

import { useState, useEffect, useRef } from 'react';
import { fetchFavorites } from '../services/FavoritesService';
import './PrescriptionGrid.css';

export function cleanValue(val) {
  if (val === null || val === undefined) return '';
  const str = String(val).trim();
  const lower = str.toLowerCase();
  if (str === '' || lower === 'null' || lower === 'n/a' || lower === 'undefined' || str === '*') {
    return '';
  }
  return str;
}

export function formatMedicineDisplay(genericName, brandName) {
  const g = cleanValue(genericName);
  const b = cleanValue(brandName);
  if (g && b) return `${g} / ${b}`;
  if (g) return g;
  if (b) return b;
  return '';
}

export function formatItemToSentence(item) {
  const med = formatMedicineDisplay(item.genericName, item.brandName);
  const d = cleanValue(item.dose);
  const f = cleanValue(item.frequency);
  const dur = cleanValue(item.duration);

  const parts = [];
  if (med) parts.push(med);
  if (d) parts.push(d);
  if (f) parts.push(f);
  if (dur) parts.push(dur);

  return parts.join(' - ');
}

export function sanitizeToAscii(input) {
  if (!input) return '';
  return String(input)
    .replaceAll('—', '-')
    .replaceAll('–', '-')
    .replaceAll('×', 'x')
    .replaceAll('•', '-')
    .replaceAll('…', '...')
    .replaceAll('’', "'")
    .replaceAll('‘', "'")
    .replaceAll('”', '"')
    .replaceAll('“', '"')
    .replace(/[^\x00-\x7F]/g, '');
}

export function parsePrescriptionRaw(raw) {
  if (!raw) return [{ genericName: '', brandName: '', dose: '', frequency: '', duration: '' }];
  if (Array.isArray(raw)) {
    return raw.map((item) => ({
      genericName: cleanValue(item.genericName || item.GenericName),
      brandName: cleanValue(item.brandName || item.BrandName),
      dose: cleanValue(item.dose || item.Dose),
      frequency: cleanValue(item.frequency || item.Frequency),
      duration: cleanValue(item.duration || item.Duration),
    }));
  }
  if (typeof raw === 'string') {
    const str = raw.trim();
    if (!str) return [{ genericName: '', brandName: '', dose: '', frequency: '', duration: '' }];
    try {
      const decoded = JSON.parse(str);
      if (Array.isArray(decoded)) {
        return decoded.map((item) => ({
          genericName: cleanValue(item.genericName || item.GenericName),
          brandName: cleanValue(item.brandName || item.BrandName),
          dose: cleanValue(item.dose || item.Dose),
          frequency: cleanValue(item.frequency || item.Frequency),
          duration: cleanValue(item.duration || item.Duration),
        }));
      }
    } catch (_) {
      // Parse plain text lines
      const lines = str.split('\n');
      const items = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.toLowerCase().includes('doctor prescription')) {
          const cleaned = trimmed.replace(/^\d+[\.\)\-]\s*/, '').replace(/^[\-\*•]\s*/, '');
          if (cleaned) {
            items.push({ genericName: cleaned, brandName: '', dose: '', frequency: '', duration: '' });
          }
        }
      }
      if (items.length > 0) return items;
    }
  }
  return [{ genericName: '', brandName: '', dose: '', frequency: '', duration: '' }];
}

export function ComboBox({ hintText, value, options, onChange, onSelectFavorite }) {
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredOptions = options.filter(
    (opt) => opt && opt.toLowerCase().includes((value || '').toLowerCase())
  );

  return (
    <div className="pg-combobox" ref={wrapperRef}>
      <div className="pg-combobox-input-wrap">
        <input
          type="text"
          className="pg-input"
          placeholder={hintText}
          value={value || ''}
          onChange={(e) => {
            onChange(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
        />
        {value && (
          <button
            type="button"
            className="pg-combobox-clear"
            onClick={() => {
              onChange('');
              setIsOpen(false);
            }}
          >
            ✕
          </button>
        )}
      </div>

      {isOpen && filteredOptions.length > 0 && (
        <ul className="pg-combobox-menu">
          {filteredOptions.map((opt, idx) => (
            <li
              key={idx}
              className="pg-combobox-item"
              onMouseDown={() => {
                onSelectFavorite(opt);
                setIsOpen(false);
              }}
            >
              {opt}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function PrescriptionGrid({ initialRawPrescription, onChange }) {
  const [items, setItems] = useState(() => parsePrescriptionRaw(initialRawPrescription));
  const [isEditing, setIsEditing] = useState(false);
  const [favorites, setFavorites] = useState([]);

  useEffect(() => {
    fetchFavorites().then((favs) => setFavorites(favs));
  }, []);

  useEffect(() => {
    if (!isEditing && initialRawPrescription) {
      setItems(parsePrescriptionRaw(initialRawPrescription));
    }
  }, [initialRawPrescription, isEditing]);

  const notifyChange = (updatedItems) => {
    const valid = updatedItems.filter(
      (i) => i.genericName || i.brandName || i.dose || i.frequency || i.duration
    );
    const jsonStr = JSON.stringify(
      valid.map((item) => ({
        GenericName: cleanValue(item.genericName) || null,
        BrandName: cleanValue(item.brandName) || null,
        Dose: cleanValue(item.dose) || null,
        Frequency: cleanValue(item.frequency) || null,
        Duration: cleanValue(item.duration) || null,
      }))
    );
    const sentenceText = valid.map(formatItemToSentence).filter(Boolean).join('\n');
    const asciiSmsText = sanitizeToAscii(sentenceText);
    if (onChange) {
      onChange({ items: valid, jsonStr, sentenceText, asciiSmsText });
    }
  };

  const handleUpdateItem = (index, field, value) => {
    const newItems = [...items];
    newItems[index] = { ...newItems[index], [field]: value };
    setItems(newItems);
  };

  const handleSelectFavorite = (index, selectedVal, isGeneric) => {
    const matched = favorites.find(
      (f) =>
        (isGeneric && f.genericName?.toLowerCase() === selectedVal.toLowerCase()) ||
        (!isGeneric && f.brandName?.toLowerCase() === selectedVal.toLowerCase())
    );

    const newItems = [...items];
    const current = newItems[index];

    if (matched) {
      newItems[index] = {
        genericName: matched.genericName || current.genericName,
        brandName: matched.brandName || current.brandName,
        dose: matched.dose || current.dose,
        frequency: matched.frequency || current.frequency,
        duration: matched.duration || current.duration,
      };
    } else {
      newItems[index] = {
        ...current,
        [isGeneric ? 'genericName' : 'brandName']: selectedVal,
      };
    }
    setItems(newItems);
  };

  const handleAddRow = () => {
    setItems([
      ...items,
      { genericName: '', brandName: '', dose: '', frequency: '', duration: '' },
    ]);
  };

  const handleRemoveRow = (index) => {
    const updated = items.filter((_, i) => i !== index);
    const next = updated.length > 0 ? updated : [{ genericName: '', brandName: '', dose: '', frequency: '', duration: '' }];
    setItems(next);
  };

  const handleSaveAndDone = () => {
    notifyChange(items);
    setIsEditing(false);
  };

  const genericOptions = Array.from(new Set(favorites.map((f) => f.genericName).filter(Boolean)));
  const brandOptions = Array.from(new Set(favorites.map((f) => f.brandName).filter(Boolean)));

  const validSentences = items.map(formatItemToSentence).filter(Boolean);

  return (
    <div className="pg-container">
      <div className="pg-header">
        <h3>{isEditing ? 'Edit Prescription Grid' : 'Prescription Summary'}</h3>
        <div className="pg-header-actions">
          {!isEditing ? (
            <button className="pg-btn pg-btn-primary" onClick={() => setIsEditing(true)}>
              ✎ Edit Prescription
            </button>
          ) : (
            <button className="pg-btn pg-btn-success" onClick={handleSaveAndDone}>
              ✓ Done Editing
            </button>
          )}
        </div>
      </div>

      {!isEditing ? (
        <div className="pg-sentence-view">
          {validSentences.length === 0 ? (
            <div className="pg-empty">
              <p>No prescription items available.</p>
              <button className="pg-btn pg-btn-primary" onClick={() => setIsEditing(true)}>
                + Add Prescription Item
              </button>
            </div>
          ) : (
            <div className="pg-sentence-list">
              {validSentences.map((sent, idx) => (
                <div key={idx} className="pg-sentence-item">
                  <span className="pg-sentence-num">{idx + 1}</span>
                  <span className="pg-sentence-text">{sent}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="pg-edit-view">
          <div className="pg-table-wrapper">
            <table className="pg-table">
              <thead>
                <tr>
                  <th style={{ width: '40%' }}>Medicine</th>
                  <th style={{ width: '18%' }}>Dose</th>
                  <th style={{ width: '18%' }}>Frequency</th>
                  <th style={{ width: '18%' }}>Duration</th>
                  <th style={{ width: '6%' }}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => (
                  <tr key={idx}>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <ComboBox
                          hintText="Generic Name"
                          value={item.genericName}
                          options={genericOptions}
                          onChange={(val) => handleUpdateItem(idx, 'genericName', val)}
                          onSelectFavorite={(val) => handleSelectFavorite(idx, val, true)}
                        />
                        <ComboBox
                          hintText="Brand Name"
                          value={item.brandName}
                          options={brandOptions}
                          onChange={(val) => handleUpdateItem(idx, 'brandName', val)}
                          onSelectFavorite={(val) => handleSelectFavorite(idx, val, false)}
                        />
                      </div>
                    </td>
                    <td>
                      <input
                        type="text"
                        className="pg-input"
                        placeholder="e.g. 500mg"
                        value={item.dose || ''}
                        onChange={(e) => handleUpdateItem(idx, 'dose', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        className="pg-input"
                        placeholder="e.g. BD"
                        value={item.frequency || ''}
                        onChange={(e) => handleUpdateItem(idx, 'frequency', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        className="pg-input"
                        placeholder="e.g. 5 days"
                        value={item.duration || ''}
                        onChange={(e) => handleUpdateItem(idx, 'duration', e.target.value)}
                      />
                    </td>
                    <td>
                      <button
                        className="pg-btn pg-btn-danger"
                        title="Remove item"
                        onClick={() => handleRemoveRow(idx)}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pg-footer">
            <button className="pg-btn" onClick={handleAddRow}>
              + Add Row
            </button>
            <button className="pg-btn pg-btn-success" onClick={handleSaveAndDone}>
              ✓ Save & View
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
