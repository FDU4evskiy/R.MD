# API оборудования

**Пример контракта** · v1 · JSON, UTF-8

Базовый адрес: `https://inventory.example.com/api/v1`. Адрес демонстрационный; запросы в примере не выполняются.

## Список оборудования

`GET /equipment?status=available&limit=50`

| Параметр | Тип     | Ограничения                        |
| -------- | ------- | ---------------------------------- |
| `status` | string  | `available`, `assigned`, `retired` |
| `limit`  | integer | 1–100; по умолчанию 50             |
| `cursor` | string  | Курсор из предыдущего ответа       |

```json
{
  "items": [
    {
      "id": "eq_1042",
      "assetTag": "IT-0042",
      "model": "ThinkPad T14",
      "status": "available",
      "location": "Склад, стеллаж B2"
    }
  ],
  "nextCursor": null
}
```

## Выдать оборудование

`POST /equipment/eq_1042/assignments`

```json
{
  "employeeId": "emp_017",
  "issuedAt": "2026-10-13T09:00:00Z"
}
```

Успех: `201 Created`. Ответ содержит `assignmentId` и новый статус `assigned`. Выдача и изменение статуса выполняются в одной транзакции.

## Ошибки

| HTTP  | `code`                  | Причина                    |
| ----- | ----------------------- | -------------------------- |
| `400` | `invalid_input`         | Неверный формат поля       |
| `404` | `equipment_not_found`   | Оборудование не существует |
| `409` | `equipment_unavailable` | Уже выдано или списано     |

```json
{
  "code": "equipment_unavailable",
  "message": "Оборудование уже выдано",
  "requestId": "req_demo_001"
}
```

Правила работы со статусами — в [спецификации](01-project.md#правила-выдачи).
